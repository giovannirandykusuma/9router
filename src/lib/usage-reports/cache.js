// Process-local, per-adapter cache of safe aggregates/options only, never raw
// usage or credentials. Auth remains mandatory before queryReport is called.
export const CACHE_LIMITS = Object.freeze({ ttlMs: 30000, maxEntries: 8, maxBytes: 4 * 1024 * 1024 });
const adapters = new WeakMap();

export function reportCache(db) {
  // Both are constant-time. total_changes covers this connection (including
  // rolled-back writes); data_version covers commits from other connections.
  // Conservatively invalidate on every write, even one above the cutoff.
  const changes = db.get('SELECT total_changes() AS n').n;
  const version = db.get('PRAGMA data_version').data_version;
  let state = adapters.get(db);
  if (!state || state.changes !== changes || state.version !== version) {
    state = { changes, version, entries: new Map(), bytes: 0 };
    adapters.set(db, state);
  }
  const remove = (key, entry) => { state.entries.delete(key); state.bytes -= entry.bytes; };
  const now = Date.now();
  for (const [key, entry] of state.entries) if (entry.expires <= now) remove(key, entry);
  return {
    get(key) {
      const entry = state.entries.get(key);
      return entry ? structuredClone(entry.value) : null;
    },
    set(key, value) {
      // Bounded walk before serialization prevents a high-cardinality result
      // from allocating an unbounded duplicate string just to measure it.
      let estimated = 0;
      const visit = (item) => {
        estimated += 16;
        if (typeof item === 'string') estimated += item.length * 6;
        else if (item && typeof item === 'object') {
          for (const field in item) {
            estimated += field.length * 6;
            if (estimated > CACHE_LIMITS.maxBytes || !visit(item[field])) return false;
          }
        }
        return estimated <= CACHE_LIMITS.maxBytes;
      };
      if (!visit(value)) return;
      const bytes = Buffer.byteLength(JSON.stringify(value));
      if (bytes > CACHE_LIMITS.maxBytes) return;
      const prior = state.entries.get(key);
      if (prior) remove(key, prior);
      while (state.entries.size >= CACHE_LIMITS.maxEntries || state.bytes + bytes > CACHE_LIMITS.maxBytes) {
        const [oldKey, oldEntry] = state.entries.entries().next().value;
        remove(oldKey, oldEntry);
      }
      state.entries.set(key, { value: structuredClone(value), bytes, expires: now + CACHE_LIMITS.ttlMs });
      state.bytes += bytes;
    },
  };
}
