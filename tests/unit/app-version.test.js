import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

const { get } = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("https", () => ({ default: { get } }));

const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
const originalBuild = process.env.APP_VERSION;
afterEach(() => {
  if (originalBuild === undefined) delete process.env.APP_VERSION;
  else process.env.APP_VERSION = originalBuild;
  delete global.__npmVersionCache;
  vi.resetModules();
  vi.clearAllMocks();
});

async function status(latest = "0.5.119", build) {
  if (build === undefined) delete process.env.APP_VERSION;
  else process.env.APP_VERSION = build;
  get.mockImplementation((_url, _options, callback) => {
    const req = new EventEmitter();
    req.destroy = vi.fn();
    queueMicrotask(() => {
      const res = new EventEmitter();
      callback(res);
      res.emit("data", JSON.stringify({ version: latest }));
      res.emit("end");
    });
    return req;
  });
  const { GET } = await import("../../src/app/api/version/route.js");
  return (await GET()).json();
}

describe("app release and fork build version", () => {
  it("reports the fully integrated upstream release consistently in the dashboard and API", async () => {
    const { APP_CONFIG } = await import("../../src/shared/constants/config.js");
    expect(pkg.version).toBe("0.5.119");
    expect(APP_CONFIG.version).toBe(pkg.version);
    expect(await status()).toEqual({
      currentVersion: pkg.version, latestVersion: "0.5.119", hasUpdate: false, buildVersion: null,
    });
  });

  it("exposes the exact build separately without treating it as a newer upstream release", async () => {
    const build = `${pkg.version}-fork-${"a".repeat(40)}`;
    expect(await status("0.5.120", build)).toEqual({
      currentVersion: pkg.version, latestVersion: "0.5.120", hasUpdate: true, buildVersion: build,
    });
    expect(get.mock.calls[0][0]).toBe("https://registry.npmjs.org/9router/latest");
  });

  it.each(["unknown", "0.5.120-fork-" + "b".repeat(40), "0.5.119-fork-short", "<script>alert(1)</script>"])(
    "does not publish unverified or mismatched build metadata: %s", async (build) => {
      expect((await status("0.5.119", build)).buildVersion).toBeNull();
    }
  );

  it("keeps npm lookup failure fail-open", async () => {
    expect(await status(null)).toEqual({
      currentVersion: pkg.version, latestVersion: null, hasUpdate: false, buildVersion: null,
    });
  });

  it("carries the workflow build identifier into the runtime container", () => {
    const dockerfile = readFileSync(new URL("../../Dockerfile", import.meta.url), "utf8");
    const runner = dockerfile.split(" AS runner")[1];
    expect(runner).toMatch(/ARG APP_VERSION/);
    expect(runner).toContain("ENV APP_VERSION=${APP_VERSION}");
    const workflow = readFileSync(new URL("../../.github/workflows/fork-image.yml", import.meta.url), "utf8");
    expect(workflow).toContain("APP_VERSION=${{ steps.meta.outputs.app }}-fork-${{ steps.meta.outputs.sha }}");
  });
});
