import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getCustomModels, setCustomModelCapsProfile } from "@/models";
import { DELETE, PATCH } from "@/app/api/models/custom/route.js";
import { GET } from "@/app/api/models/route.js";
import { installCustomCapsSource, refreshCustomCaps } from "@/lib/customCapsLoader.js";
import { getCustomCapsEntry, setCustomCapsSource } from "open-sse/providers/customCaps.js";

vi.mock("@/models", () => ({
  getModelAliases: vi.fn(async () => ({})),
  getCustomModels: vi.fn(async () => []),
  setCustomModelCapsProfile: vi.fn(async () => true),
  deleteCustomModel: vi.fn(async () => {}),
}));
vi.mock("@/lib/disabledModelsDb", () => ({ getDisabledModels: async () => ({}) }));

const providerAlias = "openai-compatible-test";
const id = "my-model";
const key = { providerAlias, id };
const qwen = { profile: "qwen", thinkingWire: "auto", overrides: {} };
const patch = (body) => PATCH({ json: async () => body });

beforeEach(() => vi.resetAllMocks());
afterEach(() => setCustomCapsSource(null));

describe("custom model capability profile API", () => {
  it("sanitizes PATCH input and refreshes the installed source", async () => {
    await installCustomCapsSource();
    getCustomModels.mockResolvedValue([{ ...key, capsProfile: qwen }]);
    const res = await patch({ ...key, capsProfile: { profile: "qwen", extra: "ignored" } });
    expect(res.status).toBe(200);
    expect(setCustomModelCapsProfile).toHaveBeenCalledWith({ ...key, type: "llm", capsProfile: qwen });
    expect(getCustomCapsEntry(providerAlias, id)).toEqual(qwen);
  });

  it("normalizes unknown enums, drops invalid overrides, and supports clearing", async () => {
    const res = await patch({ ...key, capsProfile: { profile: "unknown", thinkingWire: "unknown", overrides: { contextWindow: -1, vision: true, extra: true } } });
    expect(res.status).toBe(200);
    expect(setCustomModelCapsProfile).toHaveBeenLastCalledWith({ ...key, type: "llm", capsProfile: { profile: "auto", thinkingWire: "auto", overrides: { vision: true } } });
    expect((await patch({ ...key, capsProfile: null })).status).toBe(200);
    expect(setCustomModelCapsProfile).toHaveBeenLastCalledWith({ ...key, type: "llm", capsProfile: null });
  });

  it.each([
    { profile: "auto", thinkingWire: "auto", overrides: {} },
    { profile: "bogus", thinkingWire: "bogus" },
  ])("clears the profile when no settings remain after sanitization: %j", async (capsProfile) => {
    expect((await patch({ ...key, capsProfile })).status).toBe(200);
    expect(setCustomModelCapsProfile).toHaveBeenCalledWith({ ...key, type: "llm", capsProfile: null });
  });

  it.each([{}, { ...key }, { ...key, id: [] }, ...[[], "auto", 1, false].map((capsProfile) => ({ ...key, capsProfile })), { ...key, type: "stt", capsProfile: null }, { ...key, providerAlias: "openai", capsProfile: null }])("rejects invalid payload %j", async (body) => {
    expect((await patch(body)).status).toBe(400);
    expect(setCustomModelCapsProfile).not.toHaveBeenCalled();
  });

  it("returns 404 for a missing custom model", async () => {
    setCustomModelCapsProfile.mockResolvedValueOnce(false);
    expect((await patch({ ...key, capsProfile: qwen })).status).toBe(404);
    expect(getCustomModels).not.toHaveBeenCalled();
  });

  it("refreshes after DELETE", async () => {
    getCustomModels.mockResolvedValueOnce([{ ...key, capsProfile: qwen }]);
    await installCustomCapsSource();
    getCustomModels.mockResolvedValueOnce([]);
    expect((await DELETE({ url: `http://localhost/api/models/custom?providerAlias=${providerAlias}&id=${id}` })).status).toBe(200);
    expect(getCustomCapsEntry(providerAlias, id)).toBeNull();
  });

  it("prefers a saved profile over legacy caps while preserving legacy-only rows", async () => {
    getCustomModels.mockResolvedValue([
      { ...key, capsProfile: qwen, caps: { vision: false } },
      { ...key, id: "legacy-model", caps: { vision: true } },
    ]);
    await installCustomCapsSource();
    const { models } = await (await GET()).json();
    expect(models.find((m) => m.fullModel === `${providerAlias}/${id}`).caps.vision).toBe(true);
    expect(models.find((m) => m.fullModel === `${providerAlias}/legacy-model`).caps.vision).toBe(true);
  });

  it("fails open when startup cannot read the database, then accepts a refresh", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      getCustomModels.mockRejectedValueOnce(new Error("db error"));
      await expect(installCustomCapsSource()).resolves.toBeUndefined();
      getCustomModels.mockResolvedValueOnce([{ ...key, capsProfile: qwen }]);
      await refreshCustomCaps();
      expect(getCustomCapsEntry(providerAlias, id)).toEqual(qwen);
    } finally {
      warn.mockRestore();
    }
  });
});
