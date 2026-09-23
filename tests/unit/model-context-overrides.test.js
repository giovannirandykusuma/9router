import { afterEach, describe, expect, it } from "vitest";
import {
  aggregateComboCapabilities,
  getCapabilitiesForModel,
  getStaticCapabilitiesForModel,
  setContextWindowOverrides,
} from "../../open-sse/providers/capabilities.js";

afterEach(() => setContextWindowOverrides({}));

describe("model context overrides", () => {
  it("applies an exact canonical provider/model override", () => {
    expect(getStaticCapabilitiesForModel("codex", "gpt-6-astra").contextWindow).toBe(272000);
    setContextWindowOverrides({ "codex/gpt-6-astra": 800000 });
    expect(getCapabilitiesForModel("codex", "gpt-6-astra").contextWindow).toBe(800000);
    expect(getCapabilitiesForModel("cx", "gpt-6-astra").contextWindow).toBe(800000);
    expect(getStaticCapabilitiesForModel("codex", "gpt-6-astra").contextWindow).toBe(272000);
  });

  it("does not affect another provider serving the same model id", () => {
    setContextWindowOverrides({ "codex/gpt-5.3-codex": 800000 });
    expect(getCapabilitiesForModel("codex", "gpt-5.3-codex").contextWindow).toBe(800000);
    expect(getCapabilitiesForModel("github", "gpt-5.3-codex").contextWindow).not.toBe(800000);
  });

  it("resetting the map reveals the current registered default", () => {
    setContextWindowOverrides({ "codex/gpt-6-astra": 800000 });
    setContextWindowOverrides({});
    expect(getCapabilitiesForModel("codex", "gpt-6-astra").contextWindow).toBe(272000);
  });

  it("ignores invalid runtime values defensively", () => {
    setContextWindowOverrides({
      "codex/gpt-6-astra": -1,
      "codex/gpt-5.3-codex": "800000",
    });
    expect(getCapabilitiesForModel("codex", "gpt-6-astra").contextWindow).toBe(272000);
    expect(getCapabilitiesForModel("codex", "gpt-5.3-codex").contextWindow).not.toBe("800000");
  });

  it("flows through combo capability aggregation", () => {
    setContextWindowOverrides({ "codex/gpt-6-astra": 800000 });
    expect(aggregateComboCapabilities(["cx/gpt-6-astra"]).contextWindow).toBe(800000);
  });
});
