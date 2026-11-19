// Pure parser for context-length hints in an upstream /models list (vLLM, OpenRouter, ...).
// Browser-safe, no JSX (unit-tested directly).

const CONTEXT_FIELDS = ["max_model_len", "context_length", "context_window"];

function toPositiveInt(v) {
  if (typeof v === "string" && /^\d+$/.test(v.trim())) v = Number(v.trim());
  return Number.isInteger(v) && v > 0 ? v : null;
}

// → integer | null
export function extractContextLength(models, modelId) {
  if (!Array.isArray(models) || !modelId) return null;
  const entry = models.find(
    (m) => m && typeof m === "object" && (m.id === modelId || m.name === modelId || m.model === modelId)
  );
  if (!entry) return null;
  for (const field of CONTEXT_FIELDS) {
    const n = toPositiveInt(entry[field]);
    if (n !== null) return n;
  }
  return null;
}
