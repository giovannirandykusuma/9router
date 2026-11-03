import { beforeEach, describe, expect, it, vi } from "vitest";
import { createActiveRequestTracker } from "@/lib/activeRequests.js";

const mocks = vi.hoisted(() => ({ execute: vi.fn(), track: vi.fn(), decode: vi.fn() }));
vi.mock("../../open-sse/executors/index.js", () => ({ getExecutor: () => ({ noAuth: true, execute: mocks.execute }) }));
vi.mock("../../open-sse/utils/requestLogger.js", () => ({ createRequestLogger: async () => ({
  logClientRawRequest: vi.fn(), logRawRequest: vi.fn(), logTargetRequest: vi.fn(),
  logProviderResponse: vi.fn(), logConvertedResponse: vi.fn(), logError: vi.fn(),
}) }));
vi.mock("@/lib/usageDb.js", () => ({ trackPendingRequest: mocks.track, appendRequestLog: vi.fn(async () => {}), saveRequestDetail: vi.fn(async () => {}), saveRequestUsage: vi.fn(async () => {}) }));
vi.mock("../../open-sse/handlers/chatCore/sseToJsonHandler.js", () => ({ handleForcedSSEToJson: mocks.decode }));
const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
let pending;
function run(stream = true) {
  const body = { model: "gpt-6.1-sol", input: "hello", stream };
  return handleChatCore({ body, modelInfo: { provider: "codex", model: body.model },
    credentials: { accessToken: "fake", providerSpecificData: {} }, connectionId: "a",
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), line: vi.fn(), errorLine: vi.fn() },
    rtkEnabled: false, sourceFormatOverride: "openai-responses",
    clientRawRequest: { endpoint: "/v1/responses", body, headers: { accept: stream ? "text/event-stream" : "application/json", "user-agent": "codex-cli/0.144.1" } },
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  pending = { byModel: {}, byAccount: {} };
  mocks.track.mockImplementation(createActiveRequestTracker(pending, () => {}, () => {}));
});
function upstream(body) {
  return { response: new Response(body, { headers: { "content-type": "text/event-stream" } }), url: "https://example.invalid", headers: {} };
}
describe("chat core owns its request lifetime", () => {
  it("counts two real overlapping streams and releases each at EOF", async () => {
    const sources = [];
    mocks.execute.mockImplementation(async () => upstream(new ReadableStream({ start(c) { sources.push(c); } })));
    const a = await run(), b = await run();
    expect(pending.byModel["gpt-6.1-sol (codex)"]).toBe(2);
    const readA = a.response.text(), readB = b.response.text();
    sources[0].close(); await readA;
    expect(pending.byModel["gpt-6.1-sol (codex)"]).toBe(1);
    sources[1].close(); await readB;
    expect(pending.byModel).toEqual({});
  });
  it("cleans an executor throw without affecting another request", async () => {
    const sibling = mocks.track("gpt-6.1-sol", "codex", "a", true);
    mocks.execute.mockRejectedValue(new Error("mock connection failure"));
    const result = await run();
    expect(result.success).toBe(false);
    expect(pending.byModel["gpt-6.1-sol (codex)"]).toBe(1);
    sibling();
  });
  it("keeps nonstream requests counted while the decoder reads the upstream body", async () => {
    mocks.execute.mockResolvedValue(upstream(""));
    let release, entered;
    const started = new Promise((resolve) => { entered = resolve; });
    mocks.decode.mockImplementation(async ({ trackDone }) => {
      trackDone();
      entered();
      await new Promise((resolve) => { release = resolve; });
      return { success: true, response: new Response("{}") };
    });
    const result = run(false);
    await started;
    expect(pending.byModel["gpt-6.1-sol (codex)"]).toBe(1);
    release();
    await result;
    expect(pending.byModel).toEqual({});
  });
  it("releases nonstream decoding exceptions", async () => {
    mocks.execute.mockResolvedValue(upstream(""));
    mocks.decode.mockRejectedValue(new Error("decode failed"));
    await expect(run(false)).rejects.toThrow("decode failed");
    expect(pending.byModel).toEqual({});
  });
  it("releases cancelled streams without decrementing a sibling", async () => {
    const sibling = mocks.track("gpt-6.1-sol", "codex", "a", true);
    mocks.execute.mockResolvedValue(upstream(new ReadableStream({})));
    const result = await run();
    await result.response.body.cancel("test disconnect");
    expect(pending.byModel["gpt-6.1-sol (codex)"]).toBe(1);
    sibling();
  });
});
