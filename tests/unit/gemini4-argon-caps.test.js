import { describe, expect, it } from "vitest";

import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { getPricingForModel } from "../../open-sse/providers/pricing.js";

// Gemini 4 "Argon" (2026-09-30). Upstream PR decolua/9router#4507, with the
// output limit corrected to Google's live models.get value (32768).

describe("gemini-4-argon capabilities", () => {
  it("resolves the announced spec", () => {
    const c = getCapabilitiesForModel("gemini", "gemini-4-argon");
    expect(c.vision).toBe(true);            // image input documented
    expect(c.reasoning).toBe(true);         // reasoning model
    expect(c.search).toBe(true);            // Gemini line standard
    expect(c.contextWindow).toBe(1048576);  // 1.0M tokens
    expect(c.thinkingFormat).toBe("gemini-level");
  });

  it("has Google's reported 32K output limit, not the line's 64K", () => {
    // Google models.get for gemini-4-argon reports outputTokenLimit 32768.
    const argon = getCapabilitiesForModel("gemini", "gemini-4-argon");
    const flash = getCapabilitiesForModel("gemini", "gemini-3.8-flash");
    expect(argon.maxOutput).toBe(32768);
    expect(flash.maxOutput).toBe(65536);   // neighbours unchanged
  });

  it("is NOT captured by the gemini-3 wildcard", () => {
    // Patterns match in order, so gemini-4 needs its own entry above *gemini-3*.
    const c4 = getCapabilitiesForModel("gemini", "gemini-4-argon");
    const c3 = getCapabilitiesForModel("gemini", "gemini-3.8-flash");
    // v0.5.104 merge: upstream's Argon entry claims audio/video input (kept).
    // The distinguishing claim is now the live-verified 32K output limit,
    // which differs from the 3.x line's 64K.
    expect(c4.maxOutput).toBe(32768);
    expect(c3.maxOutput).toBe(65536);
    expect(c4.thinkingCanDisable).toBe(false);
  });

  it("leaves the rest of the Gemini line untouched", () => {
    for (const [id, expectLevel] of [
      ["gemini-3.8-flash", "gemini-level"],
      ["gemini-2.5-pro", "gemini-budget"],
      ["gemini-2.0-flash", null],
    ]) {
      const c = getCapabilitiesForModel("gemini", id);
      expect(c.thinkingFormat, id).toBe(expectLevel);
      expect(c.contextWindow, id).toBe(1048576);
    }
  });
});

describe("gemini-4-argon pricing", () => {
  it("carries the confirmed input/output rates", () => {
    const p = getPricingForModel("gemini", "gemini-4-argon");
    expect(p.input).toBe(2.00);
    expect(p.output).toBe(10.00);
  });

  it("does not invent unpublished cache/reasoning rates", () => {
    const p = getPricingForModel("gemini", "gemini-4-argon");
    // Absent, not a fabricated number — a 0 here would silently mis-bill.
    expect("cached" in p).toBe(false);
    expect("reasoning" in p).toBe(false);
    expect("cache_creation" in p).toBe(false);
  });
});