// /v1/images/edits: OpenAI multipart/JSON edit requests are translated into the
// generations body (`images` = data URLs) and run through the same pipeline,
// so Codex GPT Image receives action "edit" with the reference image attached.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handleImageGenerationCore: vi.fn(),
  enforceApiKeyLimits: vi.fn(async () => null),
  getComboModels: vi.fn(async () => null),
  settings: { requireApiKey: false },
}));

vi.mock("../../src/sse/services/auth.js", () => ({
  getProviderCredentials: async () => ({ accessToken: "t", connectionId: "conn-a", connectionName: "Codex A" }),
  markAccountUnavailable: vi.fn(async () => ({ shouldFallback: false })),
  clearAccountError: vi.fn(),
  extractApiKey: (request) => request.headers.get("Authorization")?.slice(7) || null,
  isValidApiKey: async (k) => k === "sk-good",
}));
vi.mock("@/lib/localDb", () => ({ getSettings: async () => mocks.settings }));
vi.mock("@/lib/apiKeyLimits.js", () => ({ enforceApiKeyLimits: mocks.enforceApiKeyLimits }));
vi.mock("../../src/sse/services/keyAccess.js", () => ({
  getKeyAccessContext: async () => null,
  enforceKeyAccess: async () => null,
}));
vi.mock("../../src/sse/services/model.js", () => ({
  getModelInfo: async (m) => ({ provider: "codex", model: m.replace(/^cx\//, "") }),
  getComboModels: mocks.getComboModels,
}));
vi.mock("../../open-sse/handlers/imageGenerationCore.js", () => ({
  handleImageGenerationCore: mocks.handleImageGenerationCore,
}));
vi.mock("../../src/sse/services/tokenRefresh.js", () => ({
  updateProviderCredentials: vi.fn(),
  checkAndRefreshToken: async (_p, c) => c,
}));
vi.mock("../../open-sse/services/combo.js", () => ({ handleComboChat: vi.fn() }));
vi.mock("../../src/sse/utils/logger.js", () => ({
  request: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(), maskKey: vi.fn(),
}));
vi.mock("@/lib/usageDb.js", () => ({ saveRequestUsage: vi.fn(async () => {}) }));

const { handleImageEdit, parseImageEditRequest } = await import("../../src/sse/handlers/imageEdit.js");
const route = await import("../../src/app/api/v1/images/edits/route.js");
const codex = (await import("../../open-sse/handlers/imageProviders/codex.js")).default;

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
const PNG_DATA_URL = `data:image/png;base64,${Buffer.from(PNG).toString("base64")}`;

function multipart(fields, key = "sk-good") {
  const fd = new FormData();
  for (const [k, v] of fields) fd.append(k, v);
  return new Request("http://localhost/v1/images/edits", {
    method: "POST",
    headers: key ? { Authorization: `Bearer ${key}` } : {},
    body: fd,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.settings = { requireApiKey: false };
  mocks.handleImageGenerationCore.mockResolvedValue({
    success: true,
    response: Response.json({ created: 1, data: [{ b64_json: "ZWRpdGVk" }] }),
  });
});

describe("parseImageEditRequest", () => {
  it("turns multipart image + image[] files into data URLs and keeps known fields", async () => {
    const { body, error } = await parseImageEditRequest(multipart([
      ["model", "cx/gpt-image-2.5"],
      ["prompt", "make it green"],
      ["size", "1024x1024"],
      ["n", "1"],
      ["response_format", "b64_json"],
      ["image", new Blob([PNG], { type: "image/png" })],
      ["image[]", new Blob([PNG], { type: "image/webp" })],
      ["unknown_field", "dropped"],
    ]));
    expect(error).toBeUndefined();
    expect(body).toMatchObject({ model: "cx/gpt-image-2.5", prompt: "make it green", size: "1024x1024", n: 1 });
    expect(body.images).toEqual([PNG_DATA_URL, PNG_DATA_URL.replace("image/png", "image/webp")]);
    expect(body.unknown_field).toBeUndefined();
    expect(body.image).toBeUndefined();
  });

  it("accepts a JSON body with image/images as data URLs or http URLs", async () => {
    const req = new Request("http://localhost/v1/images/edits", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "cx/gpt-image-2.5", prompt: "p", image: PNG_DATA_URL, images: [{ image_url: "https://x.test/a.png" }] }),
    });
    const { body } = await parseImageEditRequest(req);
    expect(body.images).toEqual([PNG_DATA_URL, "https://x.test/a.png"]);
    expect(body.image).toBeUndefined();
  });

  it("ignores mask (unsupported by Codex) instead of failing", async () => {
    const { body } = await parseImageEditRequest(multipart([
      ["model", "cx/gpt-image-2.5"], ["prompt", "p"],
      ["image", new Blob([PNG], { type: "image/png" })],
      ["mask", new Blob([PNG], { type: "image/png" })],
    ]));
    expect(body.mask).toBeUndefined();
    expect(body.images).toHaveLength(1);
  });

  it("rejects missing image, non-image strings, and too many images with 400", async () => {
    for (const fields of [
      [["model", "m"], ["prompt", "p"]],
      [["model", "m"], ["prompt", "p"], ["image", "file:///etc/passwd"]],
      [["model", "m"], ["prompt", "p"], ...Array.from({ length: 17 }, () => ["image[]", new Blob([PNG], { type: "image/png" })])],
    ]) {
      const { error } = await parseImageEditRequest(multipart(fields));
      expect(error.status).toBe(400);
    }
  });
});

describe("POST /v1/images/edits", () => {
  it("routes through the generations pipeline with the images attached", async () => {
    const res = await route.POST(multipart([
      ["model", "cx/gpt-image-2.5"], ["prompt", "make it green"],
      ["image", new Blob([PNG], { type: "image/png" })],
    ]));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ created: 1, data: [{ b64_json: "ZWRpdGVk" }] });
    const call = mocks.handleImageGenerationCore.mock.calls[0][0];
    expect(call.modelInfo).toEqual({ provider: "codex", model: "gpt-image-2.5" });
    expect(call.body.images).toEqual([PNG_DATA_URL]);
    expect(call.body.prompt).toBe("make it green");
  });

  it("applies per-key limits and API-key auth like generations", async () => {
    mocks.settings = { requireApiKey: true };
    expect((await handleImageEdit(multipart([["model", "cx/gpt-image-2.5"], ["prompt", "p"], ["image", new Blob([PNG])]], null))).status).toBe(401);
    expect((await handleImageEdit(multipart([["model", "cx/gpt-image-2.5"], ["prompt", "p"], ["image", new Blob([PNG])]], "sk-bad"))).status).toBe(401);
    mocks.enforceApiKeyLimits.mockResolvedValueOnce(Response.json({ error: "limit" }, { status: 429 }));
    expect((await handleImageEdit(multipart([["model", "cx/gpt-image-2.5"], ["prompt", "p"], ["image", new Blob([PNG])]]))).status).toBe(429);
    expect(mocks.handleImageGenerationCore).not.toHaveBeenCalled();
  });

  it("missing prompt is a 400 from the shared pipeline", async () => {
    const res = await handleImageEdit(multipart([["model", "cx/gpt-image-2.5"], ["image", new Blob([PNG])]]));
    expect(res.status).toBe(400);
  });
});

describe("Codex provider receives an edit action", () => {
  it("builds action=edit with the reference image as input_image", () => {
    const out = codex.buildBody("gpt-image-2.5", { prompt: "make it green", images: [PNG_DATA_URL] });
    expect(out.tools[0]).toMatchObject({ type: "image_generation", action: "edit", model: "gpt-image-2.5" });
    const content = out.input[0].content;
    expect(content.find((c) => c.type === "input_image").image_url).toBe(PNG_DATA_URL);
    expect(content.at(-1)).toEqual({ type: "input_text", text: "make it green" });
  });
});
