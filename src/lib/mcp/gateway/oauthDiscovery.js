// OAuth 2.0 discovery helpers for upstream MCP servers (RFC 9728 + 8414).

import { isRecord } from "./guards";

const META_PATHS = [
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-authorization-server",
];

function safeParse(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

function tryFetchJson(url, timeoutMs = 8000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  return fetch(url, {
    method: "GET",
    headers: { Accept: "application/json" },
    signal: ac.signal,
  })
    .then((r) => (r.ok ? r.json().catch(() => null) : null))
    .catch(() => null)
    .finally(() => clearTimeout(timer));
}

/**
 * Parse a `WWW-Authenticate` Bearer challenge for the
 * `resource_metadata="<url>"` parameter.
 * @param {unknown} wwwAuth
 * @returns {string | null}
 */
export function parseResourceMetadataFromChallenge(wwwAuth) {
  if (!wwwAuth || typeof wwwAuth !== "string") return null;
  const m = wwwAuth.match(/resource_metadata\s*=\s*"([^"]+)"/i);
  if (m) return m[1];
  const m2 = wwwAuth.match(/resource_metadata\s*=\s*([^\s,]+)/i);
  return m2 ? m2[1] : null;
}

/**
 * Resolve the well-known metadata URL for an authorization server.
 * If the AS URL already targets a well-known endpoint, returns it as-is.
 * Otherwise returns the RFC 8414 location: the well-known segment is inserted
 * between the origin and the issuer path ("/realm" -> "/.well-known/...-server/realm").
 * @param {string} asUrl
 * @returns {string | null}
 */
export function resolveWellKnownUrl(asUrl) {
  const list = resolveWellKnownUrls(asUrl);
  return list.length ? list[0] : null;
}

/**
 * All metadata URLs worth trying for an AS issuer, in priority order (MCP auth
 * spec): RFC 8414 path-insertion, OIDC path-insertion, then path-appended OIDC
 * and OAuth forms (Supabase, Keycloak, ...). Bare origins yield the plain forms.
 * @param {string} asUrl
 * @returns {string[]}
 */
export function resolveWellKnownUrls(asUrl) {
  let u;
  try { u = new URL(asUrl); } catch { return []; }
  if (u.pathname.includes("/.well-known/")) return [asUrl];
  const path = u.pathname.replace(/\/+$/, "");
  const origin = u.origin;
  const out = [
    `${origin}/.well-known/oauth-authorization-server${path}`,
    `${origin}/.well-known/openid-configuration${path}`,
  ];
  if (path) {
    out.push(`${origin}${path}/.well-known/openid-configuration`);
    out.push(`${origin}${path}/.well-known/oauth-authorization-server`);
  }
  return [...new Set(out)];
}

/**
 * Walk the OAuth discovery chain.
 * @param {string | undefined} instanceUrl
 * @param {object} [opts]
 * @returns {Promise<object | null>}
 */

export async function discoverAuth(instanceUrl, opts = {}) {
  const challengeUrl = opts.wwwAuthenticate ? parseResourceMetadataFromChallenge(opts.wwwAuthenticate) : null;
  const candidates = [];
  if (challengeUrl) candidates.push(challengeUrl);
  // RFC 9728 §3.1: path-inserted resource metadata first (".../oauth-protected-resource/mcp"),
  // then the root forms.
  try {
    const u = new URL(instanceUrl);
    const path = u.pathname.replace(/\/+$/, "");
    if (path) candidates.push(`${u.origin}/.well-known/oauth-protected-resource${path}`);
  } catch { /* bad base */ }
  for (const p of META_PATHS) {
    try { candidates.push(new URL(p, instanceUrl).toString()); } catch { /* bad base */ }
  }

  let resourceDoc = null;
  for (const url of candidates) {
    const j = await tryFetchJson(url);
    if (isRecord(j) && (Array.isArray(j.authorization_servers) || j.authorization_endpoint)) {
      resourceDoc = { ...j, _source: url };
      break;
    }
  }
  if (!resourceDoc) return null;

  const authServers = resourceDoc.authorization_servers;
  const asList = Array.isArray(authServers) && authServers.length > 0
    ? authServers
    : [new URL("/.well-known/oauth-authorization-server", instanceUrl).toString()];

  for (const asUrl of asList) {
    for (const wellKnown of resolveWellKnownUrls(asUrl)) {
      const meta = await tryFetchJson(wellKnown);
      if (isRecord(meta) && (meta.authorization_endpoint || meta.token_endpoint)) {
        return {
          ...meta,
          // Preserve registration_endpoint from the protected-resource doc if the
          // AS well-known doc does not advertise one (RFC 8414 does not require it).
          registration_endpoint: meta.registration_endpoint || resourceDoc.registration_endpoint,
          resource: resourceDoc.resource || instanceUrl,
          authorization_servers: asList,
          _discovery: { protectedResource: resourceDoc._source, as: wellKnown },
        };
      }
    }
  }
  return null;
}

export { safeParse };
