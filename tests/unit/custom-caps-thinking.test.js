import { afterEach, describe, expect, it } from "vitest";
import { applyThinking } from "../../open-sse/translator/concerns/thinkingUnified.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";
import { setCustomCapsSource, createMapSource } from "../../open-sse/providers/customCaps.js";

const P = "openai-compatible-vllm";
const M = "my-model";

function install(profile) {
  setCustomCapsSource(createMapSource(new Map([[`${P}/${M}`, profile]])));
}

function run(body, { model = M, provider = P, target = "openai" } = {}) {
  return applyThinking(target, model, { messages: [], ...body }, provider);
}

const THINKING_KEYS = ["thinking", "thinkingConfig", "enable_thinking", "thinking_budget", "reasoning_effort", "reasoning", "output_config"];

afterEach(() => setCustomCapsSource(null));

describe("vllm thinking wire (profile qwen, wire auto)", () => {
  it("thinking off → chat_template_kwargs.enable_thinking=false, no top-level fields", () => {
    install({ profile: "qwen" });
    const out = run({ reasoning_effort: "none" });
    expect(out.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(out).not.toHaveProperty("enable_thinking");
    expect(out).not.toHaveProperty("reasoning_effort");
    expect(out).not.toHaveProperty("thinking_budget");
  });

  it("effort high → enable_thinking=true + positive thinking_budget; other kwargs preserved", () => {
    install({ profile: "qwen" });
    const out = run({ reasoning_effort: "high", chat_template_kwargs: { foo: 1 } });
    expect(out.chat_template_kwargs).toEqual({ foo: 1, enable_thinking: true });
    expect(out.thinking_budget).toBeGreaterThan(0);
    expect(out).not.toHaveProperty("enable_thinking");
    expect(out).not.toHaveProperty("reasoning_effort");
  });

  it("model suffix drives the wire too", () => {
    install({ profile: "qwen" });
    const out = run({}, { model: `${M}(none)` });
    expect(out.chat_template_kwargs).toEqual({ enable_thinking: false });
  });

  it("explicit wire vllm on profile auto", () => {
    install({ thinkingWire: "vllm", overrides: { reasoning: true } });
    const out = run({ reasoning_effort: "low" });
    expect(out.chat_template_kwargs.enable_thinking).toBe(true);
    expect(out).not.toHaveProperty("reasoning_effort");
  });
});

describe("custom Chat wires on other transports", () => {
  it.each([
    { profile: "qwen" },
    { profile: "qwen", thinkingWire: "vllm" },
    { profile: "qwen", thinkingWire: "openai" },
    { profile: "qwen", thinkingWire: "qwen-dashscope" },
  ])("uses the native thinking shape for $profile / $thinkingWire", (profile) => {
    const anthropic = "anthropic-compatible-messages";
    setCustomCapsSource(createMapSource(new Map([
      [`${P}/${M}`, profile],
      [`${anthropic}/${M}`, profile],
    ])));
    const input = () => ({
      reasoning_effort: "high",
      chat_template_kwargs: { enable_thinking: true },
      thinking_budget: 4096,
    });
    const responses = run(input(), { target: "openai-responses" });
    const messages = run(input(), { provider: anthropic, target: "claude" });
    for (const out of [responses, messages]) {
      for (const key of ["chat_template_kwargs", "thinking_budget", "enable_thinking", "reasoning_effort"]) {
        expect.soft(out).not.toHaveProperty(key);
      }
    }
    expect(responses.reasoning).toEqual({ effort: "high", summary: "auto" });
    expect(messages.thinking).toMatchObject({ type: "enabled", budget_tokens: expect.any(Number) });
  });
});

describe.each([
  ["openai-responses", "openai-compatible-responses-test", { input: "hi" }],
  ["claude", "anthropic-compatible-test", { messages: [{ role: "user", content: "hi" }] }],
])("same-format %s translation with custom capabilities", (format, provider, input) => {
  function translate(model, fields) {
    return translateRequest(format, format, model, { ...structuredClone(input), ...fields }, false, null, provider);
  }

  it("strips vLLM controls even without other thinking intent", () => {
    setCustomCapsSource(createMapSource(new Map([[`${provider}/${M}`, { profile: "qwen" }]])));
    const out = translate(M, { chat_template_kwargs: { enable_thinking: false }, thinking_budget: 4096 });
    expect(out).not.toHaveProperty("chat_template_kwargs");
    expect(out).not.toHaveProperty("thinking_budget");
  });

  it.each([
    ["qwen3-32b", { contextWindow: 65536 }, { enable_thinking: true }],
    ["deepseek-r1", { contextWindow: 65536 }, { thinking: { type: "enabled" } }],
    ["opaque", { reasoning: true }, {}],
  ])("uses native thinking for saved Auto profile %s without changing unprofiled behavior", (model, overrides, baseline) => {
    expect(translate(model, { reasoning_effort: "high" })).toMatchObject(baseline);
    setCustomCapsSource(createMapSource(new Map([[`${provider}/${model}`, { overrides }]])));
    const out = translate(model, { reasoning_effort: "high" });
    expect(out).not.toHaveProperty("enable_thinking");
    expect(out).not.toHaveProperty("thinking_budget");
    expect(out).not.toHaveProperty("reasoning_effort");
    if (format === "claude") expect(out.thinking).toMatchObject({ type: "enabled", budget_tokens: expect.any(Number) });
    else {
      expect(out).not.toHaveProperty("thinking");
      expect(out.reasoning).toMatchObject({ effort: "high" });
    }
  });
});

describe("other wires", () => {
  it("none → no thinking fields at all; enable_thinking kwarg removed, other kwargs kept", () => {
    install({ profile: "qwen", thinkingWire: "none" });
    const out = run({ reasoning_effort: "high", enable_thinking: true, chat_template_kwargs: { enable_thinking: true, foo: 1 } });
    for (const k of THINKING_KEYS) expect(out).not.toHaveProperty(k);
    expect(out.chat_template_kwargs).toEqual({ foo: 1 });
  });

  it("none → drops chat_template_kwargs when it becomes empty", () => {
    install({ profile: "qwen", thinkingWire: "none" });
    const out = run({ reasoning_effort: "high", chat_template_kwargs: { enable_thinking: true } });
    expect(out).not.toHaveProperty("chat_template_kwargs");
  });

  it("none → strips stray thinking fields even with no client intent", () => {
    install({ profile: "qwen", thinkingWire: "none" });
    const out = run({ chat_template_kwargs: { enable_thinking: true, foo: 1 }, thinking_budget: 5 });
    expect(out.chat_template_kwargs).toEqual({ foo: 1 });
    expect(out).not.toHaveProperty("thinking_budget");
  });

  it("qwen-dashscope → top-level enable_thinking", () => {
    install({ profile: "qwen", thinkingWire: "qwen-dashscope" });
    const out = run({ reasoning_effort: "none" });
    expect(out.enable_thinking).toBe(false);
    expect(out).not.toHaveProperty("chat_template_kwargs");
  });

  it("openai → reasoning_effort", () => {
    install({ profile: "qwen", thinkingWire: "openai" });
    const out = run({ reasoning_effort: "high" });
    expect(out.reasoning_effort).toBe("high");
    expect(out).not.toHaveProperty("chat_template_kwargs");
    expect(out).not.toHaveProperty("enable_thinking");
  });
});

describe("native-only profiles fall back on the OpenAI wire", () => {
  for (const profile of ["claude", "gemini"]) {
    it(`profile ${profile} → reasoning_effort, no native fields`, () => {
      install({ profile });
      const out = run({ reasoning_effort: "high" });
      expect(out).not.toHaveProperty("thinking");
      expect(out).not.toHaveProperty("thinkingConfig");
      expect(out).not.toHaveProperty("generationConfig");
      expect(out).not.toHaveProperty("output_config");
      expect(out.reasoning_effort).toBe("high");
    });
  }
});

describe("no entry → unchanged behavior", () => {
  it("name-detected qwen3-32b still uses top-level enable_thinking", () => {
    const baseline = run({ reasoning_effort: "none" }, { model: "qwen3-32b" });
    install({ profile: "qwen" }); // entry for a different model
    const out = run({ reasoning_effort: "none" }, { model: "qwen3-32b" });
    expect(out).toEqual(baseline);
    expect(out.enable_thinking).toBe(false);
    expect(out).not.toHaveProperty("chat_template_kwargs");
  });

  it("caller-provided chat_template_kwargs survive on a non-reasoning model without an entry", () => {
    const out = run({ reasoning_effort: "high", chat_template_kwargs: { enable_thinking: false } }, { model: "some-plain-model" });
    expect(out.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(out).not.toHaveProperty("reasoning_effort");
  });

  it("caller-provided chat_template_kwargs survive when no thinking intent", () => {
    const out = run({ chat_template_kwargs: { enable_thinking: false } }, { model: "qwen3-32b" });
    expect(out.chat_template_kwargs).toEqual({ enable_thinking: false });
  });
});

describe("getThinkingLevels", () => {
  it("vllm entry returns base levels incl. none", () => {
    install({ profile: "qwen" });
    expect(getThinkingLevels(P, M)).toEqual(["none", "low", "medium", "high"]);
  });

  it("wire none returns only none", () => {
    install({ profile: "qwen", thinkingWire: "none" });
    expect(getThinkingLevels(P, M)).toEqual(["none"]);
  });

  it("reasoning override off → null", () => {
    install({ profile: "qwen", overrides: { reasoning: false } });
    expect(getThinkingLevels(P, M)).toBeNull();
  });
});
