// Process-local request lifetimes. No age-based expiry: reasoning streams can
// legitimately run for minutes. Each owner must release its own request once.
export function createActiveRequestTracker(pending, onChange, onError) {
  const requests = new Map();
  function adjust(model, provider, connectionId, delta) {
    const key = provider ? `${model} (${provider})` : model;
    const bump = (counts) => {
      const count = (counts[key] || 0) + delta;
      if (count > 0) counts[key] = count;
      else delete counts[key];
    };
    bump(pending.byModel);
    if (connectionId) {
      if (!pending.byAccount[connectionId]) pending.byAccount[connectionId] = {};
      bump(pending.byAccount[connectionId]);
      if (!Object.keys(pending.byAccount[connectionId]).length) delete pending.byAccount[connectionId];
    }
  }
  return function track(model, provider, connectionId, started, error = false) {
    if (!started) {
      // Compatibility for callers using the original start/stop interface.
      const entry = [...requests.values()].find((r) => r.model === model && r.provider === provider && r.connectionId === connectionId);
      entry?.finish(error);
      return;
    }
    const id = Symbol();
    const finish = (failed = false) => {
      if (!requests.delete(id)) return;
      adjust(model, provider, connectionId, -1);
      if (failed && provider) onError(provider);
      onChange();
    };
    requests.set(id, { model, provider, connectionId, finish });
    adjust(model, provider, connectionId, 1);
    onChange();
    return finish;
  };
}
