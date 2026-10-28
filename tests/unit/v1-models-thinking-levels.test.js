import { beforeEach, describe, expect, it, vi } from "vitest";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";

const db = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  getCombos: vi.fn(),
  getCustomModels: vi.fn(),
  getModelAliases: vi.fn(),
}));
vi.mock("@/lib/localDb", () => db);
vi.mock("@/lib/disabledModelsDb", () => ({ getDisabledModels: vi.fn(async () => ({})) }));
const { buildModelsList } = await import("../../src/app/api/v1/models/route.js");

beforeEach(() => {
  db.getProviderConnections.mockResolvedValue([]);
  db.getCombos.mockResolvedValue([]);
  db.getCustomModels.mockResolvedValue([]);
  db.getModelAliases.mockResolvedValue({});
});

function connect(provider, models) {
  db.getProviderConnections.mockResolvedValue([{
    id: 1, provider, isActive: true,
    providerSpecificData: { enabledModels: models },
  }]);
}

describe("/v1/models reasoning effort discovery", () => {
  it("publishes the registry for static models when there are no connections", async () => {
    const models = await buildModelsList(["llm"]);
    const sol = models.find((m) => m.id === "cx/gpt-6.1-sol");
    expect(sol).toBeDefined();
    expect(sol.capabilities.thinkingLevels).toEqual(getThinkingLevels("codex", "gpt-6.1-sol"));
    expect(sol.capabilities.thinkingLevels).toContain("max");
  });

  it("publishes max only for supported models on the active connection path", async () => {
    connect("codex", ["gpt-6.1-sol", "gpt-5.3-codex"]);
    const models = await buildModelsList(["llm"]);
    for (const id of ["gpt-6.1-sol", "gpt-5.3-codex"]) {
      expect(models.find((m) => m.id === `cx/${id}`).capabilities.thinkingLevels)
        .toEqual(getThinkingLevels("codex", id));
    }
    expect(models.find((m) => m.id === "cx/gpt-5.3-codex").capabilities.thinkingLevels).not.toContain("max");
  });

  it("resolves custom output prefixes to the real provider for models and combo seats", async () => {
    db.getProviderConnections.mockResolvedValue([{
      id: 1, provider: "codex", isActive: true,
      providerSpecificData: { prefix: " personal ", enabledModels: ["gpt-6.1-sol"] },
    }]);
    db.getCombos.mockResolvedValue([{ name: "prefixed-combo", models: ["personal/gpt-6.1-sol"] }]);
    const models = await buildModelsList(["llm"]);
    const expected = getThinkingLevels("codex", "gpt-6.1-sol");
    expect(models.find((m) => m.id === "personal/gpt-6.1-sol").capabilities.thinkingLevels).toEqual(expected);
    expect(models.find((m) => m.id === "prefixed-combo").capabilities.thinkingLevels).toEqual(expected);
  });

  it("publishes an empty set for non-reasoning models", async () => {
    connect("openai", ["gpt-4o"]);
    const models = await buildModelsList(["llm"]);
    const model = models.find((m) => m.id.endsWith("/gpt-4o"));
    expect(model.capabilities.reasoning).toBe(false);
    expect(model.capabilities.thinkingLevels).toEqual([]);
  });

  it("intersects nested combo seats and handles cycles without advertising max", async () => {
    connect("codex", ["gpt-6.1-sol", "gpt-5.3-codex"]);
    db.getCombos.mockResolvedValue([
      { name: "sol", models: ["cx/gpt-6.1-sol"] },
      { name: "mixed", models: ["sol", "cx/gpt-5.3-codex"] },
      { name: "cycle", models: ["cycle"] },
    ]);
    const models = await buildModelsList(["llm"]);
    expect(models.find((m) => m.id === "sol").capabilities.thinkingLevels).toContain("max");
    expect(models.find((m) => m.id === "mixed").capabilities.thinkingLevels).toEqual(["low", "medium", "high", "xhigh"]);
    expect(models.find((m) => m.id === "cycle").capabilities.thinkingLevels).toEqual([]);
  });
});
