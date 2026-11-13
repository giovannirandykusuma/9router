import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), agent: vi.fn(), close: vi.fn(async () => {}), lookup: vi.fn() }));
vi.mock("undici", () => ({
  fetch: mocks.fetch,
  FormData: globalThis.FormData,
  Agent: class { constructor(options) { mocks.agent(options); } close() { return mocks.close(); } },
  ProxyAgent: class {},
}));
vi.mock("dns", () => ({ lookup: mocks.lookup, Resolver: class {
  setServers() {}
  resolve4(hostname, callback) { callback(null, ["203.0.113.5"]); }
} }));
const savedEnv = { ...process.env };
const savedFetch = globalThis.fetch;
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  process.env = { ...savedEnv };
  for (const name of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy"]) delete process.env[name];
  mocks.fetch.mockResolvedValue(new Response("ok"));
});
afterEach(() => { process.env = { ...savedEnv }; globalThis.fetch = savedFetch; });

describe("fingerprint discovery obeys transport policy", () => {
  it("preserves Request auth, stream and abort signal on DNS bypass", async () => {
    const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");
    const ctrl = new AbortController();
    const request = new Request("https://cloudcode-pa.googleapis.com/v1/test", {
      method: "POST", headers: { Authorization: "Bearer original" }, body: "request body", signal: ctrl.signal,
    });
    await proxyAwareFetch(request);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    const [url, options] = mocks.fetch.mock.calls[0];
    expect(url).toBe(request.url);
    expect(options.headers.get("Authorization")).toBe("Bearer original");
    expect(await new Response(options.body).text()).toBe("request body");
    ctrl.abort();
    expect(options.signal.aborted).toBe(true);
    const connect = mocks.agent.mock.calls[0][0].connect;
    const callback = vi.fn();
    connect.lookup("cloudcode-pa.googleapis.com", { all: true }, callback);
    expect(callback).toHaveBeenCalledWith(null, [{ address: "203.0.113.5", family: 4 }], 4);
    const redirectedCallback = vi.fn();
    connect.lookup("redirect.example.com", { all: true }, redirectedCallback);
    expect(mocks.lookup).toHaveBeenCalledWith("redirect.example.com", { all: true }, redirectedCallback);
    const singleCallback = vi.fn();
    connect.lookup("cloudcode-pa.googleapis.com", {}, singleCallback);
    expect(singleCallback).toHaveBeenCalledWith(null, "203.0.113.5", 4);
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  it("refuses unresolved strict proxies before DNS bypass or discovery", async () => {
    const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");
    await expect(proxyAwareFetch("https://cloudcode-pa.googleapis.com/v1/test", {
      headers: { "User-Agent": "claude-cli/2.1.318" },
    }, { proxyPoolId: "missing", strictProxy: true })).rejects.toThrow(/none resolved/);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("does not make direct npm requests for a proxied Claude request", async () => {
    const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");
    await proxyAwareFetch("https://api.anthropic.com/v1/messages", {
      headers: { "User-Agent": "claude-cli/2.1.318", Authorization: "Bearer claude-cli/2.1.318" },
    }, { url: "http://127.0.0.1:9999", enabled: true, strictProxy: true });
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.fetch.mock.calls[0][0]).toBe("https://api.anthropic.com/v1/messages");
    expect(mocks.fetch.mock.calls[0][1].headers.Authorization).toBe("Bearer claude-cli/2.1.318");
  });

  it("does not trigger discovery based on an opaque credential", async () => {
    const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");
    await proxyAwareFetch("https://api.example.com/test", { headers: { Authorization: "Bearer claude-cli/2.1.318" } });
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.fetch.mock.calls[0][1].headers.Authorization).toBe("Bearer claude-cli/2.1.318");
  });
});
