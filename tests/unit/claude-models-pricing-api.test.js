import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let api;
let db;
let pricing;
const model = "claude-haiku-5-5";
const patch = (body) => api.PATCH(new Request("http://localhost/api/pricing", {
  method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
}));

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-haiku-pricing-api-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
  api = await import("../../src/app/api/pricing/route.js");
  db = await import("@/lib/db/index.js");
  pricing = await import("../../open-sse/providers/pricing.js");
});
afterAll(() => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  delete global._dbAdapter;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function expectScalarRates(data) {
  for (const models of Object.values(data)) {
    for (const rates of Object.values(models)) {
      expect(Object.keys(rates).every((field) => ["input", "output", "cached", "reasoning", "cache_creation"].includes(field))).toBe(true);
      expect(Object.values(rates).every((value) => typeof value === "number")).toBe(true);
    }
  }
}

describe("editable pricing API remains scalar with built-in Haiku tiers", () => {
  it("round-trips the full GET payload through PATCH as PricingModal does", async () => {
    const response = await api.GET();
    expect(response.status).toBe(200);
    const data = await response.json();
    // Saving another provider still submits every loaded model.
    data.openai = { "test-custom-model": { input: 2, output: 3 } };
    expect((await patch(data)).status).toBe(200);
    const internal = await db.getPricingForModel("claude", model);
    expect(internal.contextTiers).toHaveLength(1);
    expect(pricing.calculateCostFromTokens({ prompt_tokens: 100001, completion_tokens: 1000 }, internal)).toBeCloseTo(0.0525005, 9);
    const { getAdapter } = await import("@/lib/db/driver.js");
    const row = (await getAdapter()).get("SELECT value FROM kv WHERE scope = 'pricing' AND key = ?", ["claude"]);
    expect(JSON.parse(row?.value || "{}")).not.toHaveProperty(model);
    expectScalarRates(data);
    expect(data.claude[model]).not.toHaveProperty("contextTiers");
  });

  it("keeps defaults and the modal's failure fallback payload saveable", async () => {
    const defaults = pricing.getDefaultPricing();
    expectScalarRates(defaults);
    expect((await patch(defaults)).status).toBe(200);
    expect((await db.getPricingForModel("claude", model)).contextTiers).toHaveLength(1);
    const response = await api.GET_DEFAULTS();
    expect(response.status).toBe(200);
    expectScalarRates(await response.json());
  });

  it("returns saveable reset responses while preserving internal tiered cost", async () => {
    const response = await api.DELETE(new Request("http://localhost/api/pricing"));
    const data = await response.json();
    expect(response.status).toBe(200);
    expectScalarRates(data);
    const internal = await db.getPricingForModel("claude", model);
    expect(internal.contextTiers).toHaveLength(1);
    expect(pricing.calculateCostFromTokens({ prompt_tokens: 100001, completion_tokens: 1000 }, internal)).toBeCloseTo(0.0525005, 9);
    expect((await patch(data)).status).toBe(200);
    expect((await db.getPricingForModel("claude", model)).contextTiers).toHaveLength(1);
  });

  it("leaves partial unchanged base updates built-in, but accepts zero as an explicit override", async () => {
    await api.DELETE(new Request("http://localhost/api/pricing"));
    expect((await patch({ claude: { [model]: { input: 0.1 } } })).status).toBe(200);
    expect((await db.getPricingForModel("claude", model)).contextTiers).toHaveLength(1);
    expect((await patch({ claude: { [model]: { input: 0, output: 0 } } })).status).toBe(200);
    expect(await db.getPricingForModel("claude", model)).toEqual({ input: 0, output: 0 });
  });

  it("preserves an existing custom flat price equal to the base through an unrelated full save", async () => {
    const flat = { input: 0.1, output: 0.5, cached: 0.01, reasoning: 0.5, cache_creation: 0.125 };
    await db.updatePricing({ claude: { [model]: flat } });
    const data = await (await api.GET()).json();
    data.openai = { "another-custom-model": { input: 4, output: 6 } };
    expect((await patch(data)).status).toBe(200);
    expect(await db.getPricingForModel("claude", model)).toEqual(flat);
    expect((await db.getPricingForModel("claude", model)).contextTiers).toBeUndefined();
  });

  it.each([`?provider=claude&model=${model}`, "?provider=claude"])("restores tiered defaults for scoped reset %s", async (query) => {
    await db.updatePricing({ claude: { [model]: { input: 2, output: 3 } } });
    const response = await api.DELETE(new Request(`http://localhost/api/pricing${query}`));
    expect(response.status).toBe(200);
    expectScalarRates(await response.json());
    expect((await db.getPricingForModel("claude", model)).contextTiers).toHaveLength(1);
  });

  it("continues rejecting client-supplied tiers and honoring explicit flat overrides", async () => {
    expect((await patch({ claude: { [model]: { input: 2, contextTiers: [{ above: 100000, input: 5 }] } } })).status).toBe(400);
    const saved = await patch({ claude: { [model]: { input: 2, output: 3 } } });
    expect(saved.status).toBe(200);
    expectScalarRates(await saved.json());
    const override = await db.getPricingForModel("claude", model);
    expect(override).toEqual({ input: 2, output: 3 });
    expect(pricing.calculateCostFromTokens({ prompt_tokens: 100001, completion_tokens: 1000 }, override)).toBeCloseTo(0.203002, 9);
  });
});
