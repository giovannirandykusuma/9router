import { describe, expect, it } from "vitest";
import { getModelsByProviderId } from "../../open-sse/config/providerModels.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";
import { calculateCostFromTokens, getPricingForModel } from "../../open-sse/providers/pricing.js";
import { canonicalizeUsage } from "../../open-sse/utils/usageTracking.js";
import { applyThinking } from "../../open-sse/translator/concerns/thinkingUnified.js";
import { stripUnsupportedParams } from "../../open-sse/translator/concerns/paramSupport.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import claude from "../../open-sse/providers/registry/claude.js";
import codex from "../../open-sse/providers/registry/codex.js";
import { CLI_TOOLS } from "../../src/shared/constants/cliTools.js";
import "../translator/registerAll.js";

const model = "claude-haiku-5-5";
const think = (body) => applyThinking("claude", model, body, "claude");

describe("Claude Haiku 5.5 exact-provider refresh", () => {
  it("adds the actual ID and retains the dated Haiku 4.5", () => {
    const ids = getModelsByProviderId("claude").map((entry) => entry.id);
    expect(ids).toContain(model);
    expect(ids).toContain("claude-haiku-4-5-20251001");
    expect(ids).not.toContain("claude-haiku-latest");
  });

  it("advertises verified context, output and all supported effort levels", () => {
    expect(getCapabilitiesForModel("claude", model)).toMatchObject({
      reasoning: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000,
      maxOutput: 128000, thinkingCanDisable: true, forcedToolChoice: true,
    });
    expect(getThinkingLevels("claude", model)).toEqual(["none", "low", "medium", "high", "xhigh", "max"]);
  });

  it.each(["low", "medium", "high", "xhigh", "max"])("sends adaptive %s without manual budgets", (effort) => {
    const out = think({ thinking: { type: "enabled", budget_tokens: 4096 }, output_config: { effort } });
    expect(out.thinking).toEqual({ type: "adaptive" });
    expect(out.output_config.effort).toBe(effort);
    expect(out.thinking.budget_tokens).toBeUndefined();
  });

  it.each([{ thinking: { type: "adaptive" } }, { reasoning_effort: "auto" }])("uses medium for auto/default intent %j", (body) => {
    expect(think(structuredClone(body)).output_config.effort).toBe("medium");
  });

  it("leaves an omitted thinking preference unset (upstream defaults to adaptive/medium)", () => {
    expect(think({})).toEqual({});
  });

  it.each(["low", "medium", "high"])("preserves explicit disabled thinking at %s", (effort) => {
    expect(think({ thinking: { type: "disabled" }, output_config: { effort } })).toMatchObject({ thinking: { type: "disabled" }, output_config: { effort } });
  });

  it.each(["xhigh", "max"])("normalizes disabled + %s to adaptive", (effort) => {
    expect(think({ thinking: { type: "disabled" }, output_config: { effort } })).toMatchObject({ thinking: { type: "adaptive" }, output_config: { effort } });
  });

  it("strips rejected sampling fields only for this provider/model", () => {
    const body = { temperature: 0.4, top_p: 0.9, top_k: 20 };
    expect(stripUnsupportedParams("claude", model, { ...body })).toEqual({});
    expect(stripUnsupportedParams("claude", "claude-haiku-4-5-20251001", { ...body })).toEqual({ top_p: 0.9, top_k: 20 });
    expect(stripUnsupportedParams("opencode-go", model, { ...body })).toEqual({ top_p: 0.9, top_k: 20 });
  });

  it("normalizes the real translation pipeline and retains forced tool choice", () => {
    const out = translateRequest(FORMATS.CLAUDE, FORMATS.CLAUDE, model, {
      model, max_tokens: 2000, messages: [{ role: "user", content: "hi" }],
      thinking: { type: "enabled", budget_tokens: 1024 }, temperature: 0.5, top_p: 0.8, top_k: 8,
      tools: [{ name: "lookup", input_schema: { type: "object", properties: {} } }], tool_choice: { type: "tool", name: "lookup" },
    }, true, { apiKey: "test-api-key" }, "claude");
    expect(out.thinking.type).toBe("adaptive");
    expect(out.thinking.budget_tokens).toBeUndefined();
    expect(out.tool_choice).toEqual({ type: "tool", name: "lookup" });
    // Parameter filtering runs in the executor, after translation.
    stripUnsupportedParams("claude", model, out);
    expect(out).not.toHaveProperty("top_p");
    expect(out).not.toHaveProperty("top_k");
  });

  it("keeps Haiku 4.5 budget behavior and other providers unchanged", () => {
    const old = applyThinking("claude", "claude-haiku-4-5-20251001", { thinking: { type: "enabled", budget_tokens: 4096 } }, "claude");
    expect(old.thinking).toEqual({ type: "enabled", budget_tokens: 4096 });
    expect(getCapabilitiesForModel("opencode-go", model).thinkingDefaultEffort).toBeUndefined();
    expect(getCapabilitiesForModel(undefined, model).thinkingFormat).toBe("claude-budget");
  });

  it.each([[100000, 0.0105], [100001, 0.0525005]])("prices a %i-token prompt using the correct whole-request tier", (prompt, expected) => {
    const pricing = getPricingForModel("claude", model);
    expect(calculateCostFromTokens({ prompt_tokens: prompt, completion_tokens: 1000 }, pricing)).toBeCloseTo(expected, 9);
  });

  it("counts cache reads and writes toward the tier threshold exactly once", () => {
    const pricing = getPricingForModel("claude", model);
    const raw = { input_tokens: 1, cache_read_input_tokens: 90000, cache_creation_input_tokens: 10000, output_tokens: 1000 };
    const canonical = canonicalizeUsage(raw);
    expect(canonical.prompt_tokens).toBe(100001);
    expect(calculateCostFromTokens(canonical, pricing)).toBeCloseTo(0.0132505, 9);
    expect(calculateCostFromTokens(raw, pricing)).toBeCloseTo(0.0132505, 9);
    expect(calculateCostFromTokens(canonicalizeUsage(canonical), pricing)).toBeCloseTo(0.0132505, 9);
  });

  it("does not apply tiers to old models or explicit custom flat pricing", () => {
    expect(calculateCostFromTokens({ prompt_tokens: 100001, completion_tokens: 1000 }, { input: 2, output: 3 })).toBeCloseTo(0.203002, 9);
    expect(getPricingForModel("claude", "claude-haiku-4-5-20251001").input).toBe(1);
    expect(getPricingForModel("opencode-go", model).input).toBe(1);
  });

  it("refreshes fingerprints without changing the upstream model ID", () => {
    expect(claude.transport.headers["User-Agent"]).toBe("claude-cli/2.1.318 (external, sdk-cli)");
    expect(codex.transport.cliVersion).toBe("0.167.0");
  });

  it("sets only the generated Claude CLI Haiku default to the new ID", () => {
    const tool = Object.values(CLI_TOOLS).find((entry) => entry.modelAliases?.includes("haiku"));
    expect(tool.defaultModels.find((entry) => entry.id === "haiku").defaultValue).toBe("cc/claude-haiku-5-5");
  });
});
