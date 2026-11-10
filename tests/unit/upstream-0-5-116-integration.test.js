import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config.mjs";
import { applyThinking } from "../../open-sse/translator/concerns/thinkingUnified.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { resolveTransport } from "../../open-sse/services/provider.js";
import { OpenCodeGoExecutor } from "../../open-sse/executors/opencode-go.js";
import "../translator/registerAll.js";

describe("upstream 0.5.116 and personal fork intersections", () => {
  it("ships real undici alongside both usage report worker traces", () => {
    expect(nextConfig.serverExternalPackages).toContain("undici");
    expect(nextConfig.outputFileTracingIncludes["*"]).toContain("./node_modules/undici/**/*");
    for (const route of ["/api/usage/reports", "/api/usage/reports/export"]) {
      expect(nextConfig.outputFileTracingIncludes[route]).toEqual(expect.arrayContaining([
        "./src/lib/usage-reports/**/*",
      ]));
    }
  });

  it("uses migrated OpenCode endpoints without losing the Gemini-only lane", () => {
    const ex = new OpenCodeGoExecutor();
    expect(resolveTransport("opencode-go", FORMATS.OPENAI).baseUrl)
      .toBe("https://opencode.ai/inference/go/openai/v1/chat/completions");
    expect(resolveTransport("opencode-go", FORMATS.CLAUDE).baseUrl)
      .toBe("https://opencode.ai/inference/go/anthropic/v1/messages");
    expect(resolveTransport("opencode-go", FORMATS.OPENAI_RESPONSES).baseUrl)
      .toBe("https://opencode.ai/inference/go/openai/v1/responses");
    expect(resolveTransport("opencode-go", FORMATS.GEMINI)?.baseUrl)
      .toBe("https://opencode.ai/inference/go/v1/models");
    expect(ex.buildUrl("gpt-6-luna", true)).toBe("https://opencode.ai/inference/go/openai/v1/responses");
    expect(ex.buildUrl("gemini-4-argon-contributor", true))
      .toBe("https://opencode.ai/inference/go/v1/models/gemini-4-argon-contributor:streamGenerateContent?alt=sse");
  });

  it("preserves Haiku disabled effort on a tool-result turn through translation", () => {
    const model = "claude-haiku-5-5";
    const out = translateRequest(FORMATS.CLAUDE, FORMATS.CLAUDE, model, {
      model, max_tokens: 4096, thinking: { type: "disabled" }, output_config: { effort: "medium" },
      messages: [
        { role: "user", content: "Read file" },
        { role: "assistant", content: [{ type: "tool_use", id: "call_read", name: "read", input: { path: "a.js" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call_read", content: "hello" }] },
      ],
    }, true, {}, "claude");
    expect(out.thinking).toEqual({ type: "disabled" });
    expect(out.output_config).toEqual({ effort: "medium" });
    expect(out.messages.at(-1).content[0].type).toBe("tool_result");
  });

  it("retains exact Haiku adaptive effort across an OpenAI tool-result continuation", () => {
    const model = "claude-haiku-5-5";
    const out = translateRequest(FORMATS.OPENAI, FORMATS.CLAUDE, model, {
      model, max_tokens: 4096, reasoning_effort: "xhigh",
      messages: [
        { role: "user", content: "Read file" },
        { role: "assistant", content: null, tool_calls: [{ id: "call_read", type: "function", function: { name: "read", arguments: '{"path":"a.js"}' } }] },
        { role: "tool", tool_call_id: "call_read", content: "hello" },
      ],
    }, true, {}, "claude");
    expect(out.thinking).toMatchObject({ type: "adaptive" });
    expect(out.output_config).toEqual({ effort: "xhigh" });
    expect(out.messages.at(-1).content[0]).toMatchObject({ type: "tool_result", tool_use_id: "call_read" });
  });

  it("retains strict compatible DeepSeek budgets without leaking them to first-party hosts", () => {
    const body = () => ({ thinking: { type: "enabled", budget_tokens: 4096 } });
    expect(applyThinking(FORMATS.OPENAI, "deepseek-v4-pro", body(), "openai-compatible-local").thinking)
      .toEqual({ type: "enabled", budget_tokens: 4096 });
    expect(applyThinking(FORMATS.OPENAI, "deepseek-v4-pro", body(), "deepseek").thinking)
      .toEqual({ type: "enabled" });
  });
});
