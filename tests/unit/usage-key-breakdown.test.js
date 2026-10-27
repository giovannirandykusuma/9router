import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { SCHEMA_VERSION } from "@/lib/db/schema.js";

let dir, adapter, usage, keys;
const original = process.env.DATA_DIR;
beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-usage-"));
  process.env.DATA_DIR = dir;
  delete global._dbAdapter;
  vi.resetModules();
  adapter = await (await import("@/lib/db/driver.js")).getAdapter();
  usage = await import("@/lib/db/repos/usageRepo.js");
  keys = ["normal1", "normal2", "gateway1", "gateway2"].map((id) => ({ id, key: `sk-machine-shared-${id}`, name: id }));
  for (const [i, k] of keys.entries()) adapter.run(`INSERT INTO ${i < 2 ? "apiKeys" : "mcpGatewayKeys"}(id, key, name, machineId, createdAt) VALUES(?, ?, ?, ?, ?)`, [k.id, k.key, k.name, "machine", new Date().toISOString()]);
});
afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  fs.rmSync(dir, { recursive: true, force: true });
  if (original === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = original;
});

for (const period of ["today", "24h", "7d"]) it(`keeps all four key groups distinct in ${period}`, async () => {
  // This grouping test is not a midnight/rollup-date test. Use a fixed instant
  // whose UTC/local calendar date agrees in the supported test environments.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-15T12:00:00.000Z"));
  try {
  for (const [i, k] of keys.entries()) await usage.saveRequestUsage({ apiKey: k.key, provider: i < 2 ? "openai" : "mcp-gateway", model: i < 2 ? "gpt" : "mobbin__search_screens", tokens: {}, timestamp: new Date().toISOString() });
  const rows = Object.values((await usage.getUsageStats(period)).byApiKey);
  expect(rows).toHaveLength(4);
  expect(rows.map((r) => r.keyName).sort()).toEqual(["MCP · gateway1", "MCP · gateway2", "normal1", "normal2"]);
  expect(rows.filter((r) => r.keyType === "mcp")).toHaveLength(2);
  for (const row of rows) {
    expect(row.lastUsed).toContain("T"); // rollup overlay restores precise timestamps
    if (row.keyType === "mcp") {
      expect(row.rawModel).toBe("mobbin__search_screens");
      expect(row.provider).toBe("mcp-gateway");
    }
  }
  } finally { vi.useRealTimers(); }
});

it("names unnamed gateway keys using their id", async () => {
  adapter.run("UPDATE mcpGatewayKeys SET name = NULL WHERE id = ?", [keys[2].id]);
  await usage.saveRequestUsage({ apiKey: keys[2].key, provider: "mcp-gateway", model: "tool", tokens: {} });
  expect(Object.values((await usage.getUsageStats("today")).byApiKey)[0].keyName).toBe("MCP · gateway1");
});

it("masks distinct deleted keys with their tails", async () => {
  for (const tail of ["aaaa", "bbbb"]) await usage.saveRequestUsage({ apiKey: `sk-machine-shared-${tail}`, provider: "mcp-gateway", model: "tool", tokens: {} });
  const rows = Object.values((await usage.getUsageStats("7d")).byApiKey);
  expect(new Set(rows.map((r) => r.keyName)).size).toBe(2);
  expect(rows.map((r) => r.keyName).join(" ")).toContain("bbbb");
});

it("dashboard routes summarize bounded history by id without raw keys", async () => {
  const now = new Date();
  now.setHours(12, 0, 0, 0);
  vi.useFakeTimers();
  vi.setSystemTime(now);
  try {
    const save = async (k, days, overrides = {}) => usage.saveRequestUsage({ apiKey: k.key, provider: k.id.startsWith("gateway") ? "mcp-gateway" : "openai", model: "mobbin__search_screens", timestamp: new Date(now.getTime() - days * 86400000).toISOString(), tokens: { prompt_tokens: 3, completion_tokens: 2 }, ...overrides });
    await save(keys[2], 0, { meta: { durationMs: 100 } });
    await save(keys[2], 2, { status: "error", meta: { durationMs: 300 } });
    await save(keys[2], 10, { model: "other" });
    await save(keys[2], 31);
    await save(keys[2], 1, { provider: "openai" });
    await save(keys[0], 0);
    await save(keys[0], 10);
    await save(keys[0], 31);
    const gateway = await (await import("@/app/api/mcp-gateway/keys/usage/route.js")).GET();
    const body = await gateway.json();
    expect(body.usage.gateway1).toEqual({ today: 1, sevenDays: 2, thirtyDays: 3, errors: 1, lastUsed: now.toISOString(), avgDurationMs: 200, topTools: [{ tool: "mobbin__search_screens", count: 2 }, { tool: "other", count: 1 }] });
    expect(body.usage.gateway2.thirtyDays).toBe(0);
    expect(JSON.stringify(body)).not.toContain("sk-machine");
    expect(JSON.stringify(body)).not.toContain('"key":');
    const normal = await (await import("@/app/api/keys/usage-summary/route.js")).GET();
    expect((await normal.json()).usage.normal1).toEqual({ requests: 2, totalTokens: 10, lastUsed: now.toISOString() });
    expect(adapter.get("SELECT value FROM _meta WHERE key = 'schemaVersion'").value).toBe(String(SCHEMA_VERSION));
  } finally { vi.useRealTimers(); }
});
