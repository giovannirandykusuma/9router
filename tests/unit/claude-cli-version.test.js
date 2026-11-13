import { afterEach, describe, expect, it, vi } from "vitest";

const originalPin = process.env.CLAUDE_CLI_VERSION;
afterEach(() => {
  if (originalPin === undefined) delete process.env.CLAUDE_CLI_VERSION;
  else process.env.CLAUDE_CLI_VERSION = originalPin;
  vi.resetModules();
});

async function load(pin) {
  if (pin === undefined) delete process.env.CLAUDE_CLI_VERSION;
  else process.env.CLAUDE_CLI_VERSION = pin;
  vi.resetModules();
  return import("../../open-sse/utils/claudeCliVersion.js");
}

describe("runtime Claude CLI fingerprint discovery", () => {
  it("uses only the fixed npm endpoint, coalesces lookups and caches success", async () => {
    const mod = await load();
    let resolve;
    const fetchImpl = vi.fn(() => new Promise((done) => { resolve = done; }));
    const first = mod.ensureClaudeCliVersion(fetchImpl);
    const second = mod.ensureClaudeCliVersion(fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe("https://registry.npmjs.org/@anthropic-ai/claude-code/latest");
    expect(fetchImpl.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    resolve({ ok: true, json: async () => ({ version: "2.1.999" }) });
    expect(await first).toBe("2.1.999");
    expect(await second).toBe("2.1.999");
    await mod.ensureClaudeCliVersion(fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    for (const headers of [{ "User-Agent": "claude-cli/2.1.318 (external, sdk-cli)" }, new Headers({ "User-Agent": "claude-cli/2.1.318" }), [["User-Agent", "claude-cli/2.1.318"]]]) {
      const result = new Headers(mod.applyClaudeCliVersion(headers));
      expect(result.get("User-Agent")).toContain("claude-cli/2.1.999");
      expect(new Headers(headers).get("User-Agent")).toContain("claude-cli/2.1.318");
    }
  });

  it("fails open without lowering the bundled floor and backs off after errors", async () => {
    const mod = await load();
    mod.setClaudeCliFallback("2.1.500");
    const fetchImpl = vi.fn(async () => { throw new Error("offline"); });
    expect(await mod.ensureClaudeCliVersion(fetchImpl)).toBe("2.1.500");
    await mod.ensureClaudeCliVersion(fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(mod.applyClaudeCliVersion({ Authorization: "Bearer secret" }).Authorization).toBe("Bearer secret");
    for (const headers of [{ Authorization: "Bearer claude-cli/2.1.318" }, new Headers({ Authorization: "Bearer claude-cli/2.1.318" }), [["Authorization", "Bearer claude-cli/2.1.318"]]]) {
      expect(new Headers(mod.applyClaudeCliVersion(headers)).get("Authorization")).toBe("Bearer claude-cli/2.1.318");
    }
  });

  it.each(["2.1.1", "not-a-version"])("does not downgrade for npm value %s", async (version) => {
    const mod = await load();
    expect(await mod.ensureClaudeCliVersion(async () => ({ ok: true, json: async () => ({ version }) }))).toBe("2.1.322");
  });

  it("honors an explicit environment pin without contacting npm", async () => {
    const mod = await load("2.1.400");
    const fetchImpl = vi.fn();
    expect(await mod.ensureClaudeCliVersion(fetchImpl)).toBe("2.1.400");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
