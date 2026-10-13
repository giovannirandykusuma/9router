import { describe, it, expect } from "vitest";
import { resolveWellKnownUrl, resolveWellKnownUrls } from "@/lib/mcp/gateway/oauthDiscovery";

describe("resolveWellKnownUrl", () => {
  it("appends well-known path for bare origin AS URL", () => {
    expect(resolveWellKnownUrl("https://mcp-auth.granola.ai")).toBe(
      "https://mcp-auth.granola.ai/.well-known/oauth-authorization-server"
    );
  });

  it("keeps AS URL that already has well-known path", () => {
    const url = "https://as.example.com/.well-known/oauth-authorization-server";
    expect(resolveWellKnownUrl(url)).toBe(url);
  });

  it("inserts well-known before the issuer path (RFC 8414)", () => {
    expect(resolveWellKnownUrl("https://as.example.com/oauth2")).toBe(
      "https://as.example.com/.well-known/oauth-authorization-server/oauth2"
    );
  });

  it("handles AS URL with realm path", () => {
    expect(resolveWellKnownUrl("https://as.example.com/realm/master")).toBe(
      "https://as.example.com/.well-known/oauth-authorization-server/realm/master"
    );
  });

  it("tries path-inserted then path-appended forms for path issuers (Supabase)", () => {
    expect(resolveWellKnownUrls("https://x.supabase.co/auth/v1")).toEqual([
      "https://x.supabase.co/.well-known/oauth-authorization-server/auth/v1",
      "https://x.supabase.co/.well-known/openid-configuration/auth/v1",
      "https://x.supabase.co/auth/v1/.well-known/openid-configuration",
      "https://x.supabase.co/auth/v1/.well-known/oauth-authorization-server",
    ]);
  });

  it("bare origin yields only the two root forms", () => {
    expect(resolveWellKnownUrls("https://as.example.com/")).toEqual([
      "https://as.example.com/.well-known/oauth-authorization-server",
      "https://as.example.com/.well-known/openid-configuration",
    ]);
  });

  it("returns null for invalid URL", () => {
    expect(resolveWellKnownUrl("not-a-url")).toBeNull();
  });
});
