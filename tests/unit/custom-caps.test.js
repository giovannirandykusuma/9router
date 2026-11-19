import { afterEach, describe, expect, it } from "vitest";
import {
  CUSTOM_PROFILES,
  THINKING_WIRES,
  OVERRIDE_BOOL_KEYS,
  OVERRIDE_NUM_KEYS,
  PROFILE_TEMPLATES,
  WIRE_TO_FORMAT,
  sanitizeCapsProfile,
  setCustomCapsSource,
  getCustomCapsEntry,
  applyCustomProfile,
  resolveThinkingWireFormat,
  buildCustomCapsMap,
  createMapSource,
} from "../../open-sse/providers/customCaps.js";
import { getCapabilitiesForModel, DEFAULT_CAPABILITIES } from "../../open-sse/providers/capabilities.js";

const P = "openai-compatible-x";

function install(entries) {
  setCustomCapsSource(createMapSource(new Map(Object.entries(entries))));
}

afterEach(() => setCustomCapsSource(null));

describe("customCaps constants", () => {
  it("exposes the shared enums", () => {
    expect(CUSTOM_PROFILES).toEqual(["auto", "qwen", "claude", "openai", "gemini", "text"]);
    expect(THINKING_WIRES).toEqual(["auto", "vllm", "openai", "qwen-dashscope", "none"]);
    expect(OVERRIDE_BOOL_KEYS).toEqual(["vision", "pdf", "videoInput", "reasoning", "tools"]);
    expect(OVERRIDE_NUM_KEYS).toEqual(["contextWindow", "maxOutput"]);
    expect(WIRE_TO_FORMAT).toEqual({ vllm: "vllm", openai: "openai", "qwen-dashscope": "qwen", none: "none" });
    expect(PROFILE_TEMPLATES.qwen).toMatchObject({ vision: true, videoInput: true, reasoning: true, contextWindow: 262144, maxOutput: 32768, thinkingFormat: "vllm" });
    expect(PROFILE_TEMPLATES.text).toEqual({ tools: true, contextWindow: 200000, maxOutput: 64000 });
  });
});

describe("sanitizeCapsProfile", () => {
  it("returns null for null / non-object / arrays", () => {
    expect(sanitizeCapsProfile(null)).toBeNull();
    expect(sanitizeCapsProfile(undefined)).toBeNull();
    expect(sanitizeCapsProfile("qwen")).toBeNull();
    expect(sanitizeCapsProfile(42)).toBeNull();
    expect(sanitizeCapsProfile([1, 2])).toBeNull();
  });

  it("returns null when nothing is set", () => {
    expect(sanitizeCapsProfile({})).toBeNull();
    expect(sanitizeCapsProfile({ profile: "auto", thinkingWire: "auto", overrides: {} })).toBeNull();
    expect(sanitizeCapsProfile({ profile: "bogus", thinkingWire: "bogus", overrides: { nope: true } })).toBeNull();
  });

  it("falls back unknown profile/wire to auto", () => {
    expect(sanitizeCapsProfile({ profile: "bogus", thinkingWire: "vllm" })).toEqual({ profile: "auto", thinkingWire: "vllm", overrides: {} });
    expect(sanitizeCapsProfile({ profile: "qwen", thinkingWire: 7 })).toEqual({ profile: "qwen", thinkingWire: "auto", overrides: {} });
  });

  it("drops unknown keys, bad types, and out-of-range / non-integer numbers", () => {
    const out = sanitizeCapsProfile({
      profile: "qwen",
      overrides: {
        vision: false, pdf: "yes", videoInput: 1, reasoning: true, tools: null,
        audioInput: true, __proto__x: true,
        contextWindow: 131072, maxOutput: 999,
      },
    });
    expect(out).toEqual({ profile: "qwen", thinkingWire: "auto", overrides: { vision: false, reasoning: true, contextWindow: 131072 } });
    expect(sanitizeCapsProfile({ overrides: { contextWindow: 10000001 } })).toBeNull();
    expect(sanitizeCapsProfile({ overrides: { contextWindow: 1000.5 } })).toBeNull();
    expect(sanitizeCapsProfile({ overrides: { contextWindow: "131072" } })).toBeNull();
    expect(sanitizeCapsProfile({ overrides: { maxOutput: 1000 } })).toEqual({ profile: "auto", thinkingWire: "auto", overrides: { maxOutput: 1000 } });
    expect(sanitizeCapsProfile({ overrides: { contextWindow: 10000000 } }).overrides.contextWindow).toBe(10000000);
  });

  it("treats non-object overrides as empty", () => {
    expect(sanitizeCapsProfile({ profile: "text", overrides: "x" })).toEqual({ profile: "text", thinkingWire: "auto", overrides: {} });
  });
});

describe("applyCustomProfile", () => {
  const detected = { ...DEFAULT_CAPABILITIES, vision: true, reasoning: true, thinkingFormat: "qwen", contextWindow: 32000 };

  it("auto profile keeps detected caps", () => {
    const out = applyCustomProfile(detected, { profile: "auto", thinkingWire: "auto", overrides: { maxOutput: 5000 } }, DEFAULT_CAPABILITIES);
    expect(out).toEqual({ ...detected, maxOutput: 5000 });
  });

  it("profile template is merged over defaults, not detected", () => {
    const out = applyCustomProfile(detected, { profile: "text", thinkingWire: "auto", overrides: {} }, DEFAULT_CAPABILITIES);
    expect(out).toEqual({ ...DEFAULT_CAPABILITIES, ...PROFILE_TEMPLATES.text });
    expect(out.vision).toBe(false);
  });

  it("overrides win over the template, wire sets thinkingFormat", () => {
    const out = applyCustomProfile(detected, { profile: "claude", thinkingWire: "openai", overrides: { vision: false, contextWindow: 131072 } }, DEFAULT_CAPABILITIES);
    expect(out).toMatchObject({ vision: false, pdf: true, reasoning: true, contextWindow: 131072, maxOutput: 64000, thinkingFormat: "openai" });
  });

  it("qwen-dashscope wire maps to qwen format; none maps to none", () => {
    expect(applyCustomProfile(detected, { profile: "qwen", thinkingWire: "qwen-dashscope", overrides: {} }, DEFAULT_CAPABILITIES).thinkingFormat).toBe("qwen");
    expect(applyCustomProfile(detected, { profile: "auto", thinkingWire: "none", overrides: {} }, DEFAULT_CAPABILITIES).thinkingFormat).toBe("none");
  });

  it("does not mutate inputs", () => {
    const d = { ...detected };
    applyCustomProfile(d, { profile: "qwen", thinkingWire: "auto", overrides: { vision: false } }, DEFAULT_CAPABILITIES);
    expect(d).toEqual(detected);
  });
});

describe("getCustomCapsEntry / resolveThinkingWireFormat", () => {
  it("returns null with no source", () => {
    expect(getCustomCapsEntry(P, "my-model")).toBeNull();
    expect(resolveThinkingWireFormat(P, "my-model")).toBeNull();
  });

  it("looks up provider/model and strips a trailing (…) suffix", () => {
    install({ [`${P}/my-model`]: { profile: "qwen" } });
    expect(getCustomCapsEntry(P, "my-model")).toEqual({ profile: "qwen", thinkingWire: "auto", overrides: {} });
    expect(getCustomCapsEntry(P, "my-model(high)")).toEqual({ profile: "qwen", thinkingWire: "auto", overrides: {} });
    expect(getCustomCapsEntry(P, "other")).toBeNull();
  });

  it("only applies to compatible providers", () => {
    install({ "openai/my-model": { profile: "qwen" }, "anthropic-compatible-y/m": { profile: "text" } });
    expect(getCustomCapsEntry("openai", "my-model")).toBeNull();
    expect(getCustomCapsEntry("anthropic-compatible-y", "m")).not.toBeNull();
    expect(getCustomCapsEntry(undefined, "my-model")).toBeNull();
  });

  it("never throws: throwing source or corrupt record → null", () => {
    setCustomCapsSource({ get() { throw new Error("boom"); } });
    expect(getCustomCapsEntry(P, "my-model")).toBeNull();
    install({ [`${P}/my-model`]: "garbage" });
    expect(getCustomCapsEntry(P, "my-model")).toBeNull();
    setCustomCapsSource({});
    expect(getCustomCapsEntry(P, "my-model")).toBeNull();
  });

  it("resolveThinkingWireFormat: explicit wire, profile default, or null", () => {
    install({
      [`${P}/a`]: { profile: "qwen" },
      [`${P}/b`]: { profile: "qwen", thinkingWire: "openai" },
      [`${P}/c`]: { profile: "text" },
      [`${P}/d`]: { thinkingWire: "none" },
      [`${P}/e`]: { overrides: { vision: true } },
    });
    expect(resolveThinkingWireFormat(P, "a")).toBe("vllm");
    expect(resolveThinkingWireFormat(P, "b")).toBe("openai");
    expect(resolveThinkingWireFormat(P, "c")).toBeNull();
    expect(resolveThinkingWireFormat(P, "d")).toBe("none");
    expect(resolveThinkingWireFormat(P, "e")).toBeNull();
  });
});

describe("buildCustomCapsMap / createMapSource", () => {
  it("keys llm rows with valid capsProfile and skips the rest", () => {
    const map = buildCustomCapsMap([
      { providerAlias: P, id: "a", type: "llm", capsProfile: { profile: "qwen" } },
      { providerAlias: P, id: "b", capsProfile: { thinkingWire: "vllm" } }, // missing type → llm
      { providerAlias: P, id: "c", type: "image", capsProfile: { profile: "qwen" } },
      { providerAlias: P, id: "d", type: "llm", capsProfile: "corrupt" },
      { providerAlias: P, id: "e", type: "llm" },
      null,
      "junk",
      { id: "f", capsProfile: { profile: "qwen" } },
    ]);
    expect([...map.keys()]).toEqual([`${P}/a`, `${P}/b`]);
    expect(map.get(`${P}/a`)).toEqual({ profile: "qwen", thinkingWire: "auto", overrides: {} });
  });

  it("tolerates non-array input", () => {
    expect(buildCustomCapsMap(null).size).toBe(0);
    expect(buildCustomCapsMap({}).size).toBe(0);
  });

  it("createMapSource.get returns null for misses", () => {
    const src = createMapSource(new Map([["k", { profile: "qwen" }]]));
    expect(src.get("k")).toEqual({ profile: "qwen" });
    expect(src.get("nope")).toBeNull();
  });
});

describe("getCapabilitiesForModel custom hook", () => {
  it("no entry → identical to no source", () => {
    const base = getCapabilitiesForModel(P, "my-model");
    install({ [`${P}/other`]: { profile: "qwen" } });
    expect(getCapabilitiesForModel(P, "my-model")).toEqual(base);
  });

  it("profile qwen → vision/reasoning, 262144, vllm", () => {
    install({ [`${P}/my-model`]: { profile: "qwen" } });
    expect(getCapabilitiesForModel(P, "my-model")).toMatchObject({
      vision: true, videoInput: true, reasoning: true, contextWindow: 262144, maxOutput: 32768, thinkingFormat: "vllm",
    });
  });

  it("context override wins; vision override false", () => {
    install({ [`${P}/my-model`]: { profile: "qwen", overrides: { contextWindow: 131072, vision: false } } });
    const caps = getCapabilitiesForModel(P, "my-model");
    expect(caps.contextWindow).toBe(131072);
    expect(caps.vision).toBe(false);
  });

  it("throwing source → identical to no source", () => {
    const base = getCapabilitiesForModel(P, "my-model");
    setCustomCapsSource({ get() { throw new Error("boom"); } });
    expect(getCapabilitiesForModel(P, "my-model")).toEqual(base);
  });

  it("non-compatible provider with an entry is ignored", () => {
    const base = getCapabilitiesForModel("openai", "gpt-5");
    install({ "openai/gpt-5": { profile: "text" } });
    expect(getCapabilitiesForModel("openai", "gpt-5")).toEqual(base);
  });

  it("missing model still returns defaults", () => {
    install({ [`${P}/my-model`]: { profile: "qwen" } });
    expect(getCapabilitiesForModel(P, "")).toEqual(DEFAULT_CAPABILITIES);
  });
});
