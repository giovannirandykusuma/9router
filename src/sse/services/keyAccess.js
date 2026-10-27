// Per-API-key access control for the /v1/* inference keys.
//
// Two modes per key: UNRESTRICTED (default — exactly today's behaviour) or
// RESTRICTED, where model/combo, provider and account allowlists intersect.
// With no selections at all a restricted key denies everything. Model/combo
// selection is optional when provider/account scope exists. No wildcards, no deny mode. Matching is exact and case-insensitive, on
// RESOLVED identities, so every spelling that routes to the same target is
// treated the same and no spelling can route somewhere the list does not name:
//
//   * a request that routes as a combo (getComboModels — the lookup routing
//     itself uses) is allowed iff that combo's name is listed;
//   * a request that routes to a model is allowed iff its resolved
//     `providerId/model` equals the resolved `providerId/model` of a listed
//     model entry. So `cx/gpt-5`, `codex/gpt-5` and an alias that points there
//     are one target; a raw string that merely looks like a listed entry but
//     routes elsewhere (e.g. `MAIN` when the combo is `Main`, which routes to
//     `openai/MAIN`) is not;
//   * search/fetch (provider IS the model) are allowed iff the resolved
//     provider id is listed, or the request is a listed combo.
//
// An allowed combo grants its members when they are reached THROUGH that combo
// (the check runs once, on the requested target, before combo expansion). It
// does not grant calling a member directly by name — that needs its own entry.
// The check runs before any credential lookup, so a denied request never
// touches a provider account.
import { getApiKeyByKey } from "@/lib/db/repos/apiKeysRepo.js";
import { getCombos } from "@/lib/db/repos/combosRepo.js";
import { getModelInfo, getComboModels } from "./model.js";
import { resolveProviderId } from "@/shared/constants/providers.js";
import {
  KEY_ACCESS_COMBO_OWNER,
  KEY_ACCESS_PROVIDER_AS_MODEL_KINDS,
  keyAccessDeniedMessage,
} from "@/shared/constants/keyAccess.js";
import { errorResponse } from "open-sse/utils/error.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import * as log from "../utils/logger.js";

const lower = (s) => String(s).toLowerCase();
const canonicalModel = (provider, model) => lower(`${provider}/${model}`);

/**
 * The client key, read from the same places and in the same order as the
 * middleware (src/dashboardGuard.js) reads the key it authorizes a remote
 * /v1 call with: Bearer, x-api-key, x-goog-api-key, ?key=. Handlers' own
 * extractApiKey() only reads the first two, so using it here would let a
 * restricted key sent as x-goog-api-key look like "no key" (= unrestricted).
 */
export function extractClientApiKey(request) {
  const headers = request?.headers;
  if (!headers?.get) return null;
  const auth = headers.get("Authorization");
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  const xApiKey = headers.get("x-api-key");
  if (xApiKey) return xApiKey;
  const googKey = headers.get("x-goog-api-key");
  if (googKey) return googKey;
  try {
    return new URL(request.url).searchParams.get("key") || null;
  } catch {
    return null;
  }
}

/**
 * Access context for the request's key, or null when the request is
 * unrestricted (no key, unknown key, or a key whose access is unrestricted).
 * Keys are only authenticated elsewhere (middleware / requireApiKey); this only
 * decides what an identified key may call.
 */
export async function getKeyAccessContext(request) {
  const apiKey = extractClientApiKey(request);
  if (!apiKey) return null;
  const record = await getApiKeyByKey(apiKey);
  if (!record?.access?.restricted) return null;
  return {
    keyId: record.id,
    keyName: record.name || record.id,
    allow: record.access.allow || [],
    allowedProviders: record.access.allowedProviders || [],
    allowedConnections: record.access.allowedConnections || [],
    _sets: null,
  };
}

// Resolve the allow list once per request: combo names, resolved model ids,
// and resolved provider ids (for provider-as-model kinds).
async function getAllowSets(ctx) {
  if (ctx._sets) return ctx._sets;
  const comboNames = new Set((await getCombos()).map((c) => lower(c.name)));
  const combos = new Set();
  const models = new Set();
  const providers = new Set();
  for (const entry of ctx.allow) {
    const key = lower(entry);
    if (comboNames.has(key)) {
      combos.add(key);
      continue;
    }
    const info = await getModelInfo(entry);
    if (info?.provider && info.model) models.add(canonicalModel(info.provider, info.model));
    if (!entry.includes("/")) providers.add(lower(resolveProviderId(entry)));
  }
  const allowedProviders = new Set((ctx.allowedProviders || []).map((p) => lower(resolveProviderId(p))));
  ctx._sets = { combos, models, providers, allowedProviders };
  return ctx._sets;
}

// Account IDs are a global, immutable allowlist, intersected with the provider's
// active connections by auth.js. Never resolve IDs to provider rows here: deleted
// or unavailable records must not turn a specific-account grant into all accounts.
export async function getAllowedConnectionIdsForProvider(ctx, provider) {
  if (!ctx) return null;
  const allowedProviders = (ctx.allowedProviders || []).map((p) => lower(resolveProviderId(p)));
  if (allowedProviders.length && !allowedProviders.includes(lower(resolveProviderId(provider)))) return new Set();
  return ctx.allowedConnections?.length ? new Set(ctx.allowedConnections) : null;
}

function hasResourceScope(ctx) {
  return Boolean(ctx.allowedProviders?.length || ctx.allowedConnections?.length);
}

async function providerAllowed(ctx, provider) {
  const ids = await getAllowedConnectionIdsForProvider(ctx, provider);
  return ids === null || ids.size > 0;
}

export async function isModelStringAllowed(ctx, requested) {
  const sets = await getAllowSets(ctx);
  const info = await getModelInfo(requested);
  // provider null ⇔ an existing combo with no members (routes nowhere).
  if (!info?.provider) return sets.combos.has(lower(requested));
  if (!await providerAllowed(ctx, info.provider)) return false;
  return ctx.allow.length === 0 && hasResourceScope(ctx)
    || sets.models.has(canonicalModel(info.provider, info.model));
}

export function keyAccessDeniedResponse(ctx, requested) {
  log.warn("AUTH", `key-access: key "${ctx.keyName}" denied "${requested}"`);
  return errorResponse(HTTP_STATUS.FORBIDDEN, keyAccessDeniedMessage(requested));
}

/**
 * Gate for endpoints whose `model` may be a combo or a model (chat, image, tts).
 * Call with the requested string BEFORE combo expansion.
 * @returns {Promise<Response|null>} a 403 Response, or null when allowed.
 */
export async function enforceKeyAccess(ctx, requested) {
  if (!ctx) return null;
  if (typeof requested !== "string" || !requested) return keyAccessDeniedResponse(ctx, String(requested ?? ""));
  const sets = await getAllowSets(ctx);
  const comboModels = await getComboModels(requested);
  const allowed = comboModels
    ? (sets.combos.has(lower(requested)) || (ctx.allow.length === 0 && hasResourceScope(ctx)))
      && (await pruneComboModelsForKey(ctx, comboModels, requested)).length > 0
    : await isModelStringAllowed(ctx, requested);
  return allowed ? null : keyAccessDeniedResponse(ctx, requested);
}

/**
 * Gate for endpoints that resolve a single provider/model themselves
 * (embeddings, stt, systemone, video, Gemini-native TTS). A missing model
 * (e.g. a multipart video body we do not parse) is denied for restricted keys:
 * an unverifiable target is not an allowed one.
 */
export async function enforceKeyAccessResolved(ctx, requested, provider, model) {
  if (!ctx) return null;
  const label = requested || (provider ? `${provider}/${model ?? ""}` : "");
  if (!provider || !model) return keyAccessDeniedResponse(ctx, label);
  const sets = await getAllowSets(ctx);
  const allowed = await providerAllowed(ctx, provider)
    && (ctx.allow.length === 0 && hasResourceScope(ctx) || sets.models.has(canonicalModel(resolveProviderId(provider), model)));
  return allowed ? null : keyAccessDeniedResponse(ctx, label);
}

/**
 * Gate for search/fetch, where the provider IS the model.
 * @param {string[]|null} comboModels - routing's own combo resolution for `requested`
 */
export async function enforceKeyAccessProvider(ctx, requested, comboModels) {
  if (!ctx) return null;
  if (typeof requested !== "string" || !requested) return keyAccessDeniedResponse(ctx, String(requested ?? ""));
  const sets = await getAllowSets(ctx);
  const allowed = comboModels
    ? (sets.combos.has(lower(requested)) || (ctx.allow.length === 0 && hasResourceScope(ctx)))
      && (await pruneComboModelsForKey(ctx, comboModels, requested, true)).length > 0
    : await providerAllowed(ctx, requested)
      && (sets.providers.has(lower(resolveProviderId(requested))) || (ctx.allow.length === 0 && hasResourceScope(ctx)));
  return allowed ? null : keyAccessDeniedResponse(ctx, requested);
}

// A listed combo grants its members only THROUGH that combo, as before.
// Provider/account scope is an additional restriction, never a new model grant.
export async function pruneComboModelsForKey(ctx, models, comboName, providerAsModel = false, seen = new Set()) {
  if (!ctx || !Array.isArray(models)) return models;
  const out = [];
  for (const model of models) {
    if (seen.has(model)) continue;
    const nested = await getComboModels(model);
    if (nested) {
      if ((await pruneComboModelsForKey(ctx, nested, model, providerAsModel, new Set([...seen, model]))).length) out.push(model);
      continue;
    }
    const provider = providerAsModel ? resolveProviderId(model) : (await getModelInfo(model))?.provider;
    if (provider && await providerAllowed(ctx, provider)) out.push(model);
  }
  return out;
}

/**
 * Capacity-adapter models are appended by the gateway, not chosen by the
 * client. For a restricted key keep only the adapter models the key may call
 * directly; the original targets (already gated) are always kept. Dropping a
 * model just shortens the fallback list, so combo failover is unaffected.
 */
export async function filterAdapterModels(ctx, augmented, original) {
  if (!ctx || !Array.isArray(augmented)) return augmented;
  const keep = new Set(original || []);
  const out = [];
  for (const m of augmented) {
    if (keep.has(m) ? (await pruneComboModelsForKey(ctx, [m], "")).length > 0 : await isModelStringAllowed(ctx, m)) out.push(m);
    else log.info("AUTH", `key-access: key "${ctx.keyName}" skips adapter model "${m}" (not allowed)`);
  }
  return out;
}

/** /v1/models: a restricted key sees only the combos and models it may call. */
export async function filterModelsListForKey(ctx, list) {
  if (!ctx || !Array.isArray(list)) return list;
  const out = [];
  for (const entry of list) {
    if (!entry?.id) continue;
    if (entry.owned_by === KEY_ACCESS_COMBO_OWNER) {
      if (!await enforceKeyAccess(ctx, entry.id)) out.push(entry);
      continue;
    }
    const info = await getModelInfo(entry.id);
    if (!info?.provider) continue;
    if (KEY_ACCESS_PROVIDER_AS_MODEL_KINDS.includes(entry.kind)) {
      if (!await enforceKeyAccessProvider(ctx, info.provider, null)) out.push(entry);
      continue;
    }
    if (await isModelStringAllowed(ctx, entry.id)) out.push(entry);
  }
  return out;
}
