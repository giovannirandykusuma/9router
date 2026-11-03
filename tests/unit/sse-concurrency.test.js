import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ stats: vi.fn(), activity: vi.fn() }));
const emitter = new EventEmitter();
vi.mock("@/lib/usageDb", () => ({ getUsageStats: mocks.stats, getActiveRequests: mocks.activity, get statsEmitter() { return emitter; } }));
const { GET } = await import("@/app/api/usage/stream/route.js");
afterEach(() => { emitter.removeAllListeners(); vi.clearAllMocks(); });
it("pushes fresh concurrency totals without recomputing historical statistics", async () => {
  mocks.stats.mockResolvedValue({ totalRequests: 100, pending: { byModel: {} }, activeRequests: [] });
  mocks.activity.mockResolvedValue({ pending: { byModel: { "sol (codex)": 2 }, byAccount: {} }, activeRequests: [{ model: "sol", provider: "codex", count: 2 }], recentRequests: [], errorProvider: "" });
  const response = await GET();
  const reader = response.body.getReader();
  try {
    await reader.read();
    emitter.emit("pending");
    const { value } = await reader.read();
    const data = JSON.parse(new TextDecoder().decode(value).slice(6).trim());
    expect(data.pending.byModel["sol (codex)"]).toBe(2);
    expect(data.totalRequests).toBe(100);
    expect(mocks.stats).toHaveBeenCalledTimes(1);
  } finally { await reader.cancel(); }
  expect(emitter.listenerCount("pending")).toBe(0);
});
it("closes a failed pending push so EventSource can reconnect", async () => {
  mocks.stats.mockResolvedValue({ pending: { byModel: {} } });
  mocks.activity.mockRejectedValueOnce(new Error("DB busy"));
  const reader = (await GET()).body.getReader();
  await reader.read();
  emitter.emit("pending");
  expect((await reader.read()).done).toBe(true);
  expect(emitter.listenerCount("pending")).toBe(0);
});
it("closes an initial stats failure without registering listeners", async () => {
  mocks.stats.mockRejectedValueOnce(new Error("DB busy"));
  const reader = (await GET()).body.getReader();
  expect((await reader.read()).done).toBe(true);
  expect(emitter.listenerCount("pending")).toBe(0);
  expect(emitter.listenerCount("update")).toBe(0);
});
