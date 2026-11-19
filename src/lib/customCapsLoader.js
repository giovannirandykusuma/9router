// Server-side bridge from persisted custom models to the synchronous SSE lookup.
import { getCustomModels } from "@/models";
import { buildCustomCapsMap, setCustomCapsSource } from "open-sse/providers/customCaps.js";

const TTL_MS = 30_000;
// Next can bundle instrumentation and API routes separately. The source and
// every refresh, including the mutation route's, must share one snapshot.
const stateKey = Symbol.for("9router.customCapsLoader");
const state = globalThis[stateKey] ??= { map: new Map(), refreshedAt: -Infinity, inflight: undefined };

export function refreshCustomCaps() {
  // Queue explicit refreshes behind any pending read so a mutation always
  // gets a fresh snapshot and an older read cannot overwrite a newer one.
  const refresh = Promise.resolve(state.inflight).catch(() => {}).then(async () => {
    state.map = buildCustomCapsMap(await getCustomModels());
    state.refreshedAt = Date.now();
  }).finally(() => {
    if (state.inflight === refresh) state.inflight = undefined;
  });
  state.inflight = refresh;
  return refresh;
}

export async function installCustomCapsSource() {
  setCustomCapsSource({
    get(key) {
      if (!state.inflight && Date.now() - state.refreshedAt > TTL_MS) refreshCustomCaps().catch(() => {});
      return state.map.get(key) || null;
    },
  });
  try {
    await refreshCustomCaps();
  } catch {
    console.warn("Failed to load custom model capability profiles");
  }
}
