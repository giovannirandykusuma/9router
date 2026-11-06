import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ connection: vi.fn() }));
vi.mock("@/models", () => ({ getProviderConnectionById: mocks.connection }));
vi.mock("@/sse/services/tokenRefresh", () => ({
  refreshGoogleToken: vi.fn(), refreshCodexToken: vi.fn(), updateProviderCredentials: vi.fn(),
}));
import { GET } from "../../src/app/api/providers/[id]/models/route.js";

const list = [{ id: "claude-haiku-5-5", display_name: "Claude Haiku 5.5" }];
const request = () => GET(new Request("http://localhost/api/providers/test/models"), { params: Promise.resolve({ id: "test" }) });

describe("Claude model discovery credentials", () => {
  beforeEach(() => {
    mocks.connection.mockResolvedValue({ id: "test", provider: "claude", authType: "oauth", accessToken: "oauth-secret", apiKey: "key-secret" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ data: list })));
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("lists current IDs with OAuth Bearer and required beta, never x-api-key", async () => {
    const response = await request();
    expect(response.status).toBe(200);
    expect((await response.json()).models).toEqual(list);
    const [url, options] = fetch.mock.calls[0];
    expect(url).toBe("https://api.anthropic.com/v1/models");
    expect(options.redirect).toBe("error");
    const headers = new Headers(options.headers);
    expect(headers.get("authorization")).toBe("Bearer oauth-secret");
    expect(headers.get("anthropic-beta")).toContain("oauth-2025-04-20");
    expect(headers.get("anthropic-version")).toBe("2023-06-01");
    expect(headers.has("x-api-key")).toBe(false);
  });

  it("selects the API key for apikey connections even with a stale access token", async () => {
    mocks.connection.mockResolvedValue({ id: "test", provider: "claude", authType: "apikey", accessToken: "stale-oauth-secret", apiKey: "key-secret" });
    expect((await request()).status).toBe(200);
    const headers = new Headers(fetch.mock.calls[0][1].headers);
    expect(headers.get("x-api-key")).toBe("key-secret");
    expect(headers.has("authorization")).toBe(false);
    expect(headers.has("anthropic-beta")).toBe(false);
  });

  it.each(["oauth", "apikey"])("does not borrow the other credential when %s is missing", async (authType) => {
    mocks.connection.mockResolvedValue({ id: "test", provider: "claude", authType, ...(authType === "oauth" ? { apiKey: "key-secret" } : { accessToken: "oauth-secret" }) });
    expect((await request()).status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("retains access-token inference for legacy connections without authType", async () => {
    mocks.connection.mockResolvedValue({ id: "test", provider: "claude", accessToken: "oauth-secret" });
    expect((await request()).status).toBe(200);
    expect(new Headers(fetch.mock.calls[0][1].headers).get("authorization")).toBe("Bearer oauth-secret");
  });

  it.each(["upstream", "network"])("does not expose credentials through %s errors or logs", async (kind) => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    if (kind === "upstream") fetch.mockResolvedValue(new Response("oauth-secret key-secret", { status: 401 }));
    else fetch.mockRejectedValue(new Error("oauth-secret key-secret"));
    const response = await request();
    expect(response.status).toBe(kind === "upstream" ? 401 : 502);
    expect(await response.text()).not.toMatch(/oauth-secret|key-secret/);
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/oauth-secret|key-secret/);
  });
});
