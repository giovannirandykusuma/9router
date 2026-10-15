import { describe, expect, it } from "vitest";
import { PROVIDER_MODELS, getModelTargetFormat, getModelSupportedFormats } from "../../open-sse/config/providerModels.js";
import { resolveTransport } from "../../open-sse/services/provider.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { OpenCodeGoExecutor } from "../../open-sse/executors/opencode-go.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import "../translator/registerAll.js";
import { translateRequest } from "../../open-sse/translator/index.js";

// Fork: Gemini 4 Argon via OpenCode Go. Probed live 2026-10-15 — the zen
// chat/messages/responses lanes answer "ModelProtocolUnsupported"; only the
// Gemini-native /inference/go/v1/models/{id}:generateContent lane serves it.
const MODEL = "gemini-4-argon-contributor";
const BASE = "https://opencode.ai/inference/go/v1/models";

// Mirror of chatCore's per-model transport selection.
function chatCoreTransport(provider, sourceFormat, alias, model) {
  const supported = getModelSupportedFormats(alias, model);
  const target = getModelTargetFormat(alias, model);
  const rt = resolveTransport(provider, sourceFormat);
  const targetRt = target ? resolveTransport(provider, target) : null;
  return (!supported || supported.includes(sourceFormat)) ? rt : targetRt;
}

describe("ocg/gemini-4-argon-contributor catalog", () => {
  it("is registered gemini-native", () => {
    const entry = (PROVIDER_MODELS["opencode-go"] || []).find((m) => m.id === MODEL);
    expect(entry).toBeDefined();
    expect(getModelTargetFormat("opencode-go", MODEL)).toBe(FORMATS.GEMINI);
    expect(getModelSupportedFormats("opencode-go", MODEL)).toEqual([FORMATS.GEMINI]);
  });

  it("routes every client format to the gemini transport", () => {
    for (const src of [FORMATS.OPENAI, FORMATS.CLAUDE, FORMATS.OPENAI_RESPONSES, FORMATS.GEMINI]) {
      const t = chatCoreTransport("opencode-go", src, "opencode-go", MODEL);
      expect(t?.format, src).toBe(FORMATS.GEMINI);
      expect(t?.baseUrl, src).toBe(BASE);
    }
  });

  it("does not move other models onto the gemini lane", () => {
    expect(chatCoreTransport("opencode-go", FORMATS.OPENAI, "opencode-go", "kimi-k3")?.format).toBe(FORMATS.OPENAI);
    expect(chatCoreTransport("opencode-go", FORMATS.CLAUDE, "opencode-go", "minimax-m3")?.format).toBe(FORMATS.CLAUDE);
    // Unknown passthrough ids still default to the chat lane.
    expect(getModelTargetFormat("opencode-go", "some-new-model")).toBeNull();
  });

  it("gets Gemini 4 capabilities", () => {
    expect(getCapabilitiesForModel("opencode-go", MODEL)).toMatchObject({
      reasoning: true,
      thinkingFormat: "gemini-level",
      contextWindow: 1048576,
      maxOutput: 32768,
    });
  });
});

describe("OpenCodeGoExecutor gemini lane", () => {
  const ex = new OpenCodeGoExecutor();
  const openaiRt = { format: "openai", baseUrl: "https://opencode.ai/zen/go/v1/chat/completions", auth: { combined: true, header: "Authorization", scheme: "bearer" } };

  it("builds the stream / non-stream Gemini URL, ignoring a stale runtimeTransport", () => {
    expect(ex.buildUrl(MODEL, true)).toBe(`${BASE}/${MODEL}:streamGenerateContent?alt=sse`);
    expect(ex.buildUrl(MODEL, false)).toBe(`${BASE}/${MODEL}:generateContent`);
    expect(ex.buildUrl(`${MODEL}(high)`, true, 0, { runtimeTransport: openaiRt }))
      .toBe(`${BASE}/${MODEL}:streamGenerateContent?alt=sse`);
  });

  it("authenticates with x-goog-api-key and keeps the session header", () => {
    const h = ex.buildHeaders({ apiKey: "k", runtimeTransport: openaiRt, _opencodeGoSession: "ses_x" }, true, "", MODEL);
    expect(h["x-goog-api-key"]).toBe("k");
    expect(h.Authorization).toBeUndefined();
    expect(h["x-opencode-session"]).toBe("ses_x");
  });

  it("leaves non-gemini models on bearer auth", () => {
    const h = ex.buildHeaders({ apiKey: "k", runtimeTransport: openaiRt, _opencodeGoSession: "ses_x" }, true, "", "kimi-k3");
    expect(h.Authorization).toBe("Bearer k");
    expect(h["x-goog-api-key"]).toBeUndefined();
  });

  it("passes a Gemini body through, minus the body-level model", () => {
    const body = { model: MODEL, contents: [{ role: "user", parts: [{ text: "hi" }] }], generationConfig: { maxOutputTokens: 10 } };
    const out = ex.transformRequest(MODEL, body, true, {});
    expect(out.model).toBeUndefined();
    expect(out.contents).toEqual(body.contents);
    expect(out.generationConfig).toEqual(body.generationConfig);
    expect(out.messages).toBeUndefined();
  });
});

describe("openai client → ocg/gemini-4-argon-contributor translation", () => {
  it("translates chat messages + tools to Gemini contents with level thinking", () => {
    const body = {
      model: MODEL,
      stream: true,
      reasoning_effort: "high",
      messages: [
        { role: "system", content: "be brief" },
        { role: "user", content: "read foo" },
        { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: "{\"path\":\"foo\"}" } }] },
        { role: "tool", tool_call_id: "c1", content: "hello" },
      ],
      tools: [{ type: "function", function: { name: "read", parameters: { type: "object", properties: { path: { type: "string" } } } } }],
    };
    const out = translateRequest(FORMATS.OPENAI, FORMATS.GEMINI, MODEL, body, true, {}, "opencode-go");
    expect(out.messages).toBeUndefined();
    expect(out.systemInstruction?.parts?.[0]?.text).toContain("be brief");
    expect(out.contents.map((c) => c.role)).toEqual(["user", "model", "user"]);
    expect(out.contents[1].parts.some((p) => p.functionCall?.name === "read")).toBe(true);
    expect(out.contents[2].parts.some((p) => p.functionResponse?.name === "read")).toBe(true);
    expect(out.tools?.[0]?.functionDeclarations?.[0]?.name).toBe("read");
    expect(out.generationConfig?.thinkingConfig?.thinkingLevel).toBe("high");
  });
});
