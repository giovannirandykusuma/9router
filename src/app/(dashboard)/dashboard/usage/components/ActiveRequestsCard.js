"use client";

export default function ActiveRequestsCard({ pending, activeRequests = [], live = false }) {
  const total = Object.values(pending?.byModel || {}).reduce((sum, count) => sum + count, 0);
  const groups = new Map();
  for (const request of activeRequests) {
    const key = `${request.provider}/${request.model}`;
    const group = groups.get(key) || { provider: request.provider, model: request.model, count: 0, accounts: [] };
    group.count += request.count;
    group.accounts.push(request);
    groups.set(key, group);
  }
  return (
    <section className="rounded-xl border border-border-subtle bg-surface p-5" aria-label="Active requests">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-sm font-medium text-text-muted">Active requests</h3>
          <div className="mt-1 text-3xl font-semibold tabular-nums">{live ? total : "—"}</div>
        </div>
        <span className={`text-xs ${live ? "text-emerald-500" : "text-text-muted"}`} role="status">
          {live ? "Live" : "Reconnecting · count unavailable"}
        </span>
      </div>
      <p className="mt-2 text-xs text-text-muted">In-flight chat requests on this instance, across all time periods. Not a capacity limit.</p>
      {live && total === 0 && <p className="mt-3 text-sm text-text-muted">No requests in progress.</p>}
      {live && [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, group]) => (
        <details key={key} className="mt-3 border-t border-border pt-3 text-sm">
          <summary className="cursor-pointer">{group.provider} · {group.model} <span className="ml-2 font-semibold tabular-nums">{group.count}</span></summary>
          <ul className="mt-2 space-y-1 pl-4 text-xs text-text-muted">
            {group.accounts.map((request, index) => <li key={`${request.account}-${index}`} className="flex justify-between gap-4"><span className="break-all">{request.account}</span><span className="tabular-nums">{request.count}</span></li>)}
          </ul>
        </details>
      ))}
    </section>
  );
}
