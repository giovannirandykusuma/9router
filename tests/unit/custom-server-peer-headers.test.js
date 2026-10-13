// custom-server.js is the only thing that makes x-9r-real-ip trustworthy. Boot a real
// HTTP server through it and confirm a client cannot smuggle its own peer headers in.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createRequire } from "node:module";
import http from "node:http";
import { __test__ as requestDetails } from "@/lib/db/repos/requestDetailsRepo.js";

const require = createRequire(import.meta.url);

let server;
let baseUrl;
let seenHeaders;

beforeAll(async () => {
  require("../../custom-server.js");
  server = http.createServer((req, res) => {
    seenHeaders = req.headers;
    res.end("ok");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function get(headers = {}) {
  await fetch(baseUrl, { headers });
  return seenHeaders;
}

describe("custom-server peer header sanitizing", () => {
  it("generates a peer trust token at boot", () => {
    expect(process.env.NINEROUTER_PEER_TOKEN).toMatch(/^[0-9a-f]{48}$/);
  });

  it("replaces a client-supplied x-9r-real-ip with the socket address", async () => {
    const headers = await get({ "x-9r-real-ip": "203.0.113.55" });

    expect(headers["x-9r-real-ip"]).toMatch(/^(::ffff:)?127\.0\.0\.1$/);
  });

  it("stamps the trust token so downstream can tell the wrapper ran", async () => {
    const headers = await get();

    expect(headers["x-9r-peer-token"]).toBe(process.env.NINEROUTER_PEER_TOKEN);
  });

  it("drops a client-supplied peer trust token", async () => {
    const headers = await get({ "x-9r-peer-token": "forged-token" });

    expect(headers["x-9r-peer-token"]).toBe(process.env.NINEROUTER_PEER_TOKEN);
    expect(headers["x-9r-peer-token"]).not.toBe("forged-token");
  });

  it("drops a client-supplied x-9r-via-proxy marker", async () => {
    const headers = await get({ "x-9r-via-proxy": "1" });

    expect(headers["x-9r-via-proxy"]).toBeUndefined();
  });

  it("marks via-proxy and adopts the forwarded IP for a loopback proxy hop", async () => {
    const headers = await get({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" });

    expect(headers["x-9r-via-proxy"]).toBe("1");
    expect(headers["x-9r-real-ip"]).toBe("203.0.113.9");
    expect(headers["x-forwarded-for"]).toBeUndefined();
  });

  // chat.js snapshots every client header into the request detail. Anything that grants
  // access must not survive into a record the dashboard renders and cloud sync uploads.
  it("keeps the peer token out of persisted request details", () => {
    const sanitized = requestDetails.sanitizeHeaders({
      "x-9r-peer-token": "secret",
      "x-9r-cli-token": "secret",
      "authorization": "Bearer sk-x",
      "x-9r-real-ip": "127.0.0.1",
    });

    expect(sanitized["x-9r-peer-token"]).toBeUndefined();
    expect(sanitized["x-9r-cli-token"]).toBeUndefined();
    expect(sanitized["authorization"]).toBeUndefined();
    expect(sanitized["x-9r-real-ip"]).toBe("127.0.0.1");
  });
});

// Caddy on the host reaches a container through docker-proxy, so the socket peer is the
// bridge gateway (172.17.0.1), not loopback. Without TRUSTED_PROXY_IPS every remote client
// collapses into that one address and shares a single login-lockout bucket.
describe("custom-server trusted proxy hops (TRUSTED_PROXY_IPS)", () => {
  const { __resolveClientIp: resolve } = require("../../custom-server.js");
  const prev = process.env.TRUSTED_PROXY_IPS;
  afterAll(() => {
    if (prev === undefined) delete process.env.TRUSTED_PROXY_IPS;
    else process.env.TRUSTED_PROXY_IPS = prev;
  });

  it("ignores forwarding headers from a non-loopback peer by default", () => {
    delete process.env.TRUSTED_PROXY_IPS;
    expect(resolve("172.17.0.1", "203.0.113.7", undefined)).toBe("172.17.0.1");
    expect(resolve("::ffff:172.17.0.1", undefined, "203.0.113.7")).toBe("::ffff:172.17.0.1");
  });

  it("adopts X-Real-IP / first XFF hop from a configured proxy IP (v4 and v4-mapped)", () => {
    process.env.TRUSTED_PROXY_IPS = "172.17.0.1";
    expect(resolve("172.17.0.1", "203.0.113.7", undefined)).toBe("203.0.113.7");
    expect(resolve("::ffff:172.17.0.1", undefined, "198.51.100.4, 10.0.0.1")).toBe("198.51.100.4");
  });

  it("does not trust other non-loopback peers even when the list is set", () => {
    process.env.TRUSTED_PROXY_IPS = "172.17.0.1";
    expect(resolve("203.0.113.50", "1.2.3.4", "1.2.3.4")).toBe("203.0.113.50");
    expect(resolve("172.17.0.2", "1.2.3.4", undefined)).toBe("172.17.0.2");
  });

  it("keeps the socket address when a trusted proxy sends no forwarding header", () => {
    process.env.TRUSTED_PROXY_IPS = "172.17.0.1, 10.0.0.9";
    expect(resolve("10.0.0.9", undefined, undefined)).toBe("10.0.0.9");
  });

  it("still trusts loopback with no configuration", () => {
    delete process.env.TRUSTED_PROXY_IPS;
    expect(resolve("127.0.0.1", "203.0.113.8", undefined)).toBe("203.0.113.8");
  });
});
