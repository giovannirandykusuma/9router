// Per-model custom capability profiles for openai-/anthropic-compatible providers.
//
// An admin can pin a custom model (e.g. a vLLM `--served-model-name`) to a caps
// profile + thinking wire + per-capability overrides. Stored on the customModels
// record as `capsProfile: { profile, thinkingWire, overrides }`.
//
// Pure, browser-safe JS: no node:*, no fs/db, no src/ imports. The server (or the
// dashboard page) installs a lookup source via setCustomCapsSource(); with no
// source installed every lookup returns null and behavior is unchanged.

export const CUSTOM_PROFILES = ["auto", "qwen", "claude", "openai", "gemini", "text"];
export const THINKING_WIRES = ["auto", "vllm", "openai", "qwen-dashscope", "none"];
export const OVERRIDE_BOOL_KEYS = ["vision", "pdf", "videoInput", "reasoning", "tools"];
export const OVERRIDE_NUM_KEYS = ["contextWindow", "maxOutput"];
export const OVERRIDE_NUM_MIN = 1000;
export const OVERRIDE_NUM_MAX = 10000000;

export const PROFILE_TEMPLATES = {
  qwen: { vision: true, videoInput: true, reasoning: true, tools: true, contextWindow: 262144, maxOutput: 32768, thinkingFormat: "vllm" },
  claude: { vision: true, pdf: true, reasoning: true, tools: true, contextWindow: 200000, maxOutput: 64000, thinkingFormat: "claude-adaptive" },
  openai: { vision: true, reasoning: true, tools: true, contextWindow: 400000, maxOutput: 128000, thinkingFormat: "openai" },
  gemini: { vision: true, pdf: true, audioInput: true, videoInput: true, reasoning: true, tools: true, contextWindow: 1048576, maxOutput: 65536, thinkingFormat: "gemini-level" },
  text: { tools: true, contextWindow: 200000, maxOutput: 64000 },
};

export const WIRE_TO_FORMAT = { vllm: "vllm", openai: "openai", "qwen-dashscope": "qwen", none: "none" };

const COMPATIBLE_PREFIXES = ["openai-compatible-", "anthropic-compatible-"];

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// → { profile, thinkingWire, overrides } | null (null = nothing set / invalid input)
export function sanitizeCapsProfile(input) {
  if (!isPlainObject(input)) return null;
  const profile = CUSTOM_PROFILES.includes(input.profile) ? input.profile : "auto";
  const thinkingWire = THINKING_WIRES.includes(input.thinkingWire) ? input.thinkingWire : "auto";
  const overrides = {};
  const raw = isPlainObject(input.overrides) ? input.overrides : {};
  for (const key of OVERRIDE_BOOL_KEYS) {
    if (typeof raw[key] === "boolean") overrides[key] = raw[key];
  }
  for (const key of OVERRIDE_NUM_KEYS) {
    const n = raw[key];
    if (Number.isInteger(n) && n >= OVERRIDE_NUM_MIN && n <= OVERRIDE_NUM_MAX) overrides[key] = n;
  }
  if (profile === "auto" && thinkingWire === "auto" && Object.keys(overrides).length === 0) return null;
  return { profile, thinkingWire, overrides };
}

// source: { get(key) → capsProfile|null } | null. Stored on globalThis so every
// bundled copy of this module (Next server chunks) sees the same source.
export function setCustomCapsSource(source) {
  if (typeof globalThis !== "undefined") globalThis.__9rCustomCapsSource = source || null;
}

function getSource() {
  return (typeof globalThis !== "undefined" && globalThis.__9rCustomCapsSource) || null;
}

// → sanitized capsProfile | null. Never throws.
export function getCustomCapsEntry(provider, model) {
  try {
    if (typeof provider !== "string" || !model) return null;
    if (!COMPATIBLE_PREFIXES.some((p) => provider.startsWith(p))) return null;
    const source = getSource();
    if (!source || typeof source.get !== "function") return null;
    const id = String(model);
    let raw = source.get(`${provider}/${id}`);
    if (!raw) {
      const stripped = id.replace(/\([^()]*\)\s*$/, "").trim();
      if (stripped && stripped !== id) raw = source.get(`${provider}/${stripped}`);
    }
    return raw ? sanitizeCapsProfile(raw) : null;
  } catch {
    return null;
  }
}

// base = profile auto ? detected : defaults + template; overrides win; explicit wire sets thinkingFormat.
export function applyCustomProfile(detected, entry, defaults) {
  if (!entry) return detected;
  const template = entry.profile !== "auto" ? PROFILE_TEMPLATES[entry.profile] : null;
  const base = template ? { ...defaults, ...template } : { ...detected };
  const caps = { ...base, ...(entry.overrides || {}) };
  if (entry.thinkingWire && entry.thinkingWire !== "auto" && WIRE_TO_FORMAT[entry.thinkingWire]) {
    caps.thinkingFormat = WIRE_TO_FORMAT[entry.thinkingWire];
  }
  return caps;
}

// → thinking format forced by the custom entry, or null to keep normal resolution.
export function resolveThinkingWireFormat(provider, model) {
  const entry = getCustomCapsEntry(provider, model);
  if (!entry) return null;
  if (entry.thinkingWire !== "auto") return WIRE_TO_FORMAT[entry.thinkingWire] ?? null;
  if (entry.profile !== "auto") return PROFILE_TEMPLATES[entry.profile]?.thinkingFormat ?? null;
  return null;
}

// rows = customModels records → Map("<providerAlias>/<id>" → sanitized capsProfile).
export function buildCustomCapsMap(rows) {
  const map = new Map();
  if (!Array.isArray(rows)) return map;
  for (const row of rows) {
    try {
      if (!isPlainObject(row)) continue;
      if ((row.type || "llm") !== "llm") continue;
      if (typeof row.providerAlias !== "string" || !row.providerAlias) continue;
      if (typeof row.id !== "string" || !row.id) continue;
      const profile = sanitizeCapsProfile(row.capsProfile);
      if (profile) map.set(`${row.providerAlias}/${row.id}`, profile);
    } catch {
      // corrupt row → skip
    }
  }
  return map;
}

export function createMapSource(map) {
  return { get(key) { return map.get(key) || null; } };
}
