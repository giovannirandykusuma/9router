// Server-side bridge from persisted custom models to the synchronous SSE lookup.
import { getCustomModels } from "@/models";
import { buildCustomCapsMap, setCustomCapsSource } from "open-sse/providers/customCaps.js";

const TTL_MS = 30_000;
let map = new Map();
let refreshedAt = -Infinity;
let inflight;

export function refreshCustomCaps() {
  // Queue explicit refreshes behind any pending read so a mutation always
  // gets a fresh snapshot and an older read cannot overwrite a newer one.
  const refresh = Promise.resolve(inflight).catch(() => {}).then(async () => {
    map = buildCustomCapsMap(await getCustomModels());
    refreshedAt = Date.now();
  }).finally(() => {
    if (inflight === refresh) inflight = undefined;
  });
  inflight = refresh;
  return refresh;
}

export async function installCustomCapsSource() {
  setCustomCapsSource({
    get(key) {
      if (!inflight && Date.now() - refreshedAt > TTL_MS) refreshCustomCaps().catch(() => {});
      return map.get(key) || null;
    },
  });
  try {
    await refreshCustomCaps();
  } catch {
    console.warn("Failed to load custom model capability profiles");
  }
}
