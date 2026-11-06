import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;
let limits;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-haiku-pricing-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  delete global._apiKeyLimitState;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  limits = await import("@/lib/apiKeyLimits.js");
});
afterAll(() => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  delete global._dbAdapter;
  delete global._apiKeyLimitState;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const model = "claude-haiku-5-5";
describe("Haiku model pricing persistence and budget enforcement", () => {
  it("persists the higher-tier cost and enforces it against the API key budget", async () => {
    const key = await db.createApiKey("haiku-tier", "test-machine", { monthlyBudget: 0.04 });
    expect(await limits.checkApiKeyLimits(key.key)).toBeNull();
    const entry = { provider: "claude", model, apiKey: key.key, tokens: { prompt_tokens: 100001, cached_tokens: 0, completion_tokens: 1000 }, status: "ok" };
    await db.saveRequestUsage(entry);
    expect(entry.cost).toBeCloseTo(0.0525005, 9);
    expect((await limits.checkApiKeyLimits(key.key)).message).toMatch(/monthly budget/);
  });

  it("keeps explicit user pricing ahead of the tiered default", async () => {
    await db.updatePricing({ claude: { [model]: { input: 2, output: 3 } } });
    expect(await db.getPricingForModel("claude", model)).toEqual({ input: 2, output: 3 });
    const entry = { provider: "claude", model, tokens: { prompt_tokens: 100001, completion_tokens: 1000 }, status: "ok" };
    await db.saveRequestUsage(entry);
    expect(entry.cost).toBeCloseTo(0.203002, 9);
  });
});
