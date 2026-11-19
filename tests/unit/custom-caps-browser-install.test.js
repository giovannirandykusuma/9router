import { describe, it, expect, afterEach } from "vitest";
import { installBrowserCustomCaps } from "../../src/shared/utils/installBrowserCustomCaps.js";

const rows = [{ providerAlias: "openai-compatible-x", id: "m1", type: "llm", capsProfile: { profile: "qwen" } }];

describe("installBrowserCustomCaps", () => {
  const prevSource = globalThis.__9rCustomCapsSource;
  const hadWindow = "window" in globalThis;
  const prevWindow = globalThis.window;

  afterEach(() => {
    globalThis.__9rCustomCapsSource = prevSource;
    if (hadWindow) globalThis.window = prevWindow;
    else delete globalThis.window;
  });

  it("no-ops on the server (no window): existing source untouched", () => {
    delete globalThis.window;
    const serverSource = { get: () => null };
    globalThis.__9rCustomCapsSource = serverSource;
    expect(installBrowserCustomCaps([])).toBe(false);
    expect(installBrowserCustomCaps(rows)).toBe(false);
    expect(globalThis.__9rCustomCapsSource).toBe(serverSource);
  });

  it("installs a map source in the browser", () => {
    globalThis.window = {};
    globalThis.__9rCustomCapsSource = { get: () => null };
    expect(installBrowserCustomCaps(rows)).toBe(true);
    const src = globalThis.__9rCustomCapsSource;
    expect(src.get("openai-compatible-x/m1")).toMatchObject({ profile: "qwen", thinkingWire: "auto" });
    expect(src.get("openai-compatible-x/other")).toBeNull();
  });
});
