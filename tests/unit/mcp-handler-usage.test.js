import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, afterEach, it, expect, vi } from "vitest";

const mocks = vi.hoisted(() => ({ dispatch: vi.fn() }));
vi.mock("@/lib/mcp/gateway/aggregator", () => ({ dispatchToolCall: mocks.dispatch }));
let dir, adapter, handle;
const original = process.env.DATA_DIR;
const rawKey = "sk-shared-machine-secret-tail";
beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-handler-"));
  process.env.DATA_DIR = dir;
  delete global._dbAdapter;
  vi.resetModules();
  adapter = await (await import("@/lib/db/driver.js")).getAdapter();
  adapter.run("INSERT INTO mcpGatewayKeys(id, key, name, machineId, createdAt) VALUES(?, ?, ?, ?, ?)", ["k", rawKey, "test", "machine", new Date().toISOString()]);
  const repo = await import("@/lib/db/repos/mcpInstancesRepo.js");
  const instance = await repo.createInstance({ name: "Test", slug: "test", kind: "http", transport: "streamable-http", url: "https://example.com/mcp" });
  await (await import("@/lib/db/repos/mcpGatewayRepo.js")).setGrants("k", [instance.id]);
  handle = (await import("@/lib/mcp/gateway/handler.js")).handleJsonRpc;
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  fs.rmSync(dir, { recursive: true, force: true });
  if (original === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = original;
});
const request = (key = rawKey, extra = {}) => new Request("http://localhost/api/mcp-gateway", { headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...extra } });
const body = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "test__tool", arguments: { secret: "argument-secret" } } };

for (const failure of [false, true]) it(`persists only duration and sanitized error (failure=${failure})`, async () => {
  if (failure) mocks.dispatch.mockRejectedValueOnce(new Error(`line one\n${"x".repeat(300)}`));
  else mocks.dispatch.mockResolvedValueOnce({ result: { content: [{ type: "text", text: "result-secret" }] } });
  await handle(request(), body);
  await vi.waitFor(() => expect(adapter.get("SELECT COUNT(*) AS n FROM usageHistory").n).toBe(1));
  const row = adapter.get("SELECT * FROM usageHistory");
  const meta = JSON.parse(row.meta);
  expect(meta.durationMs).toEqual(expect.any(Number));
  expect(meta.durationMs).toBeGreaterThanOrEqual(0);
  if (failure) {
    expect(meta.error.length).toBeLessThanOrEqual(200);
    expect(meta.error).not.toMatch(/[\r\n]/);
    expect(row.status).toBe("error");
  }
  expect(JSON.stringify(row)).not.toContain("argument-secret");
  expect(JSON.stringify(row)).not.toContain("result-secret");
});

it("auth warnings are one-line, contain no key material, and throttle per reason", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.useFakeTimers();
  for (let i = 0; i < 3; i++) await handle(request("secret-invalid", { "x-forwarded-for": "127.0.0.1, 8.8.8.8" }), body);
  for (let i = 0; i < 3; i++) await handle(request(null), body);
  expect(warn.mock.calls.map((c) => c[0])).toEqual(["[mcp-gw] auth failed: invalid from 127.0.0.1", "[mcp-gw] auth failed: missing from local"]);
  vi.advanceTimersByTime(10000);
  await handle(request("secret-invalid", { "x-forwarded-for": "secret-invalid" }), body);
  expect(warn).toHaveBeenCalledTimes(3);
  expect(JSON.stringify(warn.mock.calls)).not.toContain("secret-invalid");
  expect(adapter.get("SELECT COUNT(*) AS n FROM usageHistory").n).toBe(0);
});
