"use client";

import { useEffect, useRef, useState } from "react";
import { DateTime } from "luxon";
import dynamic from "next/dynamic";
import Card from "./Card";

const ReportCharts = dynamic(() => import("./UsageReportsCharts"), { ssr: false });
const METRICS = [
  ["requests", "Recorded requests"], ["inputTokens", "Input tokens"],
  ["outputTokens", "Output tokens"], ["totalTokens", "Total tokens"],
  ["cachedTokens", "Cached tokens"], ["cacheCreationTokens", "Cache creation"],
  ["reasoningTokens", "Reasoning tokens"], ["cost", "Estimated cost"],
];
const fieldClass = "w-full min-w-0 rounded-lg border border-border bg-bg px-3 py-2 text-sm";
const buttonClass = "rounded-lg border border-border px-3 py-2 text-sm font-medium hover:bg-bg-subtle disabled:opacity-40 disabled:cursor-not-allowed";
export function formatReportValue(value, metric) {
  if (value === null || value === undefined) return "Unknown";
  return metric === "cost"
    ? new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 6 }).format(value)
    : new Intl.NumberFormat().format(value);
}
function paramsFor(filters, extra = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries({ ...filters, ...extra })) {
    if (value !== "" && value !== null && value !== undefined) params.set(key, String(value));
  }
  return params;
}
function Field({ label, children }) {
  return <label className="flex min-w-0 flex-col gap-1.5 text-xs font-medium text-text-muted">{label}{children}</label>;
}
function ReportTable({ title, rows, columns, testId }) {
  return <Card className="min-w-0" padding="sm">
    <h3 className="mb-3 font-semibold">{title}</h3>
    <div className="overflow-x-auto" tabIndex={0} role="region" aria-label={title}>
      <table className="w-full text-left text-xs" data-testid={testId}>
        <thead><tr className="border-b border-border">{columns.map(([key, label]) => <th key={key} className="px-3 py-2 whitespace-nowrap text-text-muted">{label}</th>)}</tr></thead>
        <tbody>{rows.map((row, i) => <tr key={row.id ?? i} className="border-b border-border/50">{columns.map(([key, , render]) => <td key={key} className="max-w-[260px] break-words px-3 py-2 align-top">{render ? render(row[key], row) : row[key] || "Unknown"}</td>)}</tr>)}</tbody>
      </table>
    </div>
  </Card>;
}

function initialFilters() {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const today = DateTime.now().setZone(timezone);
  return { startDate: today.minus({ days: 29 }).toISODate(), endDate: today.toISODate(), timezone, keyId: "", provider: "", connectionId: "", model: "" };
}

export default function UsageReports() {
  // This component is client-only; initialize from the browser, not server time.
  const [draft, setDraft] = useState(initialFilters);
  const [query, setQuery] = useState(() => ({ filters: draft, page: 1 }));
  const [result, setResult] = useState(null);
  const [options, setOptions] = useState({ keys: [], providers: [], accounts: [], models: [] });
  const [zones] = useState(() => [...new Set([draft.timezone, "UTC", ...(Intl.supportedValuesOf?.("timeZone") || [])])].sort());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState("");
  const generation = useRef(0);
  const exportAbort = useRef(null);

  useEffect(() => () => exportAbort.current?.abort(), []);

  function requestReport(nextQuery) {
    // Invalidate in the event handler, before an old response can update the UI.
    ++generation.current;
    exportAbort.current?.abort();
    setExporting(false);
    setLoading(true);
    setResult(null);
    setError("");
    setExportError("");
    setQuery(nextQuery);
  }

  useEffect(() => {
    if (!query) return;
    const controller = new AbortController();
    const id = ++generation.current;
    fetch(`/api/usage/reports?${paramsFor(query.filters, { page: query.page, pageSize: 25, cutoff: query.cutoff })}`, { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(response.status === 401 ? "Sign in as a dashboard administrator to view reports." : data.error || "Unable to load report.");
        if (id !== generation.current || controller.signal.aborted) return;
        setResult(data);
        setOptions(data.options);
      })
      .catch((e) => { if (!controller.signal.aborted && id === generation.current) setError(e.message || "Unable to load report."); })
      .finally(() => { if (!controller.signal.aborted && id === generation.current) setLoading(false); });
    return () => controller.abort();
  }, [query]);

  function change(key, value) { setDraft((current) => ({ ...current, [key]: value })); }
  function apply(event) {
    event.preventDefault();
    requestReport({ filters: { ...draft }, page: 1 });
  }
  async function download() {
    if (!result || loading || exporting) return;
    const id = generation.current;
    const controller = new AbortController();
    exportAbort.current = controller;
    setExporting(true);
    setExportError("");
    try {
      const response = await fetch(`/api/usage/reports/export?${paramsFor(query.filters, { cutoff: result.cutoff })}`, { cache: "no-store", signal: controller.signal });
      if (!response.ok) {
        const data = await response.json();
        throw new Error(response.status === 401 ? "Sign in as a dashboard administrator to export reports." : data.error || "Unable to export report.");
      }
      const blob = await response.blob();
      if (id !== generation.current || controller.signal.aborted) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "usage-report.xlsx";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      if (!controller.signal.aborted && id === generation.current) setExportError(e.message || "Unable to export report.");
    } finally {
      if (id === generation.current) setExporting(false);
    }
  }
  const dirty = draft && query && JSON.stringify(draft) !== JSON.stringify(query.filters);
  const overExportLimit = result && result.summary.requests > result.limits.maxExportRows;
  const formatMetric = (metric) => function MetricCell(value, row) {
    return <>
      {formatReportValue(value, metric)}
      {row.known && metric !== "requests" && row.known[metric] < row.requests && <span className="block text-text-muted">{row.known[metric]} / {row.requests} recorded</span>}
    </>;
  };

  return <section className="flex min-w-0 flex-col gap-5" aria-label="Usage reports">
    <div>
      <h2 className="text-lg font-semibold">Usage reports</h2>
      <p className="mt-1 text-sm text-text-muted">Recorded inference usage only. MCP tool calls are excluded. Costs are historical estimates, not invoices or subscription charges.</p>
    </div>
    {draft && <Card padding="sm">
      <form onSubmit={apply} className="flex flex-col gap-4" aria-label="Report filters">
        <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Field label="Start date"><input aria-label="Start date" type="date" required value={draft.startDate} onChange={(e) => change("startDate", e.target.value)} className={fieldClass} /></Field>
          <Field label="End date (inclusive)"><input aria-label="End date" type="date" required value={draft.endDate} onChange={(e) => change("endDate", e.target.value)} className={fieldClass} /></Field>
          <Field label="Timezone"><input aria-label="Timezone" list="report-timezones" required value={draft.timezone} onChange={(e) => change("timezone", e.target.value)} className={fieldClass} /><datalist id="report-timezones">{zones.map((zone) => <option key={zone} value={zone} />)}</datalist></Field>
          <Field label="Inference API key"><select aria-label="Inference API key" value={draft.keyId} onChange={(e) => change("keyId", e.target.value)} className={fieldClass}><option value="">All keys (including unattributed)</option>{options.keys.map((key) => <option key={key.id} value={key.id}>{key.name || key.id}</option>)}</select></Field>
          <Field label="Provider"><select aria-label="Provider" value={draft.provider} onChange={(e) => change("provider", e.target.value)} className={fieldClass}><option value="">All providers</option>{options.providers.map((provider) => <option key={provider} value={provider}>{provider}</option>)}</select></Field>
          <Field label="Account"><select aria-label="Account" value={draft.connectionId} onChange={(e) => change("connectionId", e.target.value)} className={fieldClass}><option value="">All accounts</option>{options.accounts.map((account) => <option key={account.id} value={account.id}>{account.name || account.id}</option>)}</select></Field>
          <Field label="Exact model"><input aria-label="Exact model" list="report-models" value={draft.model} onChange={(e) => change("model", e.target.value)} placeholder="All models" className={fieldClass} /><datalist id="report-models">{[...new Set(options.models.map((model) => model.model))].map((model) => <option key={model} value={model} />)}</datalist></Field>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" className={`${buttonClass} bg-primary text-white`}>Apply filters</button>
          <button type="button" className={buttonClass} disabled={loading} onClick={() => requestReport({ filters: { ...query.filters }, page: 1 })}>Refresh snapshot</button>
          <span className="text-xs text-text-muted">Up to 366 days · 50,000 rows per export{dirty ? " · Unapplied changes" : ""}</span>
        </div>
      </form>
    </Card>}
    {loading && <div role="status" className="rounded-xl border border-border p-8 text-center text-text-muted">Loading report…</div>}
    {error && <div role="alert" className="rounded-xl border border-red-500/30 bg-red-500/5 p-4 text-sm">{error} <button type="button" className="ml-2 underline" onClick={() => requestReport({ ...query })}>Retry</button></div>}
    {result && !loading && <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="min-w-0 break-words text-xs text-text-muted" data-testid="report-scope">{result.filters.startDate} – {result.filters.endDate} · {result.filters.timezone} · Snapshot #{result.cutoff}{dirty ? " · Showing applied filters" : ""}</p>
        <button type="button" onClick={download} disabled={exporting || overExportLimit} className={buttonClass}>{exporting ? "Exporting…" : "Download XLSX"}</button>
      </div>
      {overExportLimit && <p className="text-sm text-text-muted">This report exceeds the 50,000-request export limit. Narrow the date range or filters to download.</p>}
      {exportError && <p role="alert" className="text-sm text-red-500">{exportError}</p>}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="report-summary">{METRICS.map(([metric, label]) => <Card key={metric} padding="sm">
        <p className="text-xs text-text-muted">{label}</p>
        <p className="mt-2 break-words text-xl font-semibold tabular-nums" data-testid={`metric-${metric}`}>{formatReportValue(result.summary[metric], metric)}</p>
        {metric !== "requests" && <p className="mt-1 text-xs text-text-muted">{result.summary.known[metric] ?? 0} / {result.summary.requests} recorded{result.summary.known[metric] > 0 && result.summary.known[metric] < result.summary.requests ? " · partial" : ""}</p>}
      </Card>)}</div>
      <p className="text-xs text-text-muted">Unknown means not recorded, not zero. Partial totals include only known values. Cached and reasoning tokens are subsets and are not added to total tokens again.</p>
      {result.summary.requests === 0 ? <Card><p className="py-6 text-center text-sm text-text-muted" role="status">No recorded requests match these filters.</p></Card> : <>
        <ReportCharts daily={result.daily} byModel={result.byModel} timezone={result.filters.timezone} />
        <ReportTable title="By account" testId="report-accounts" rows={result.byAccount} columns={[["accountName", "Account"], ["provider", "Provider"], ["requests", "Requests", formatMetric("requests")], ["inputTokens", "Input", formatMetric("inputTokens")], ["outputTokens", "Output", formatMetric("outputTokens")], ["cost", "Estimated USD", formatMetric("cost")]]} />
        <ReportTable title="Requests" testId="report-requests" rows={result.requests} columns={[
          ["timestamp", `Time (${result.filters.timezone})`, (value) => DateTime.fromISO(value).setZone(result.filters.timezone).toFormat("yyyy-MM-dd HH:mm:ss ZZZZ")],
          ["keyName", "Key"], ["provider", "Provider"], ["accountName", "Account"], ["model", "Model"],
          ["inputTokens", "Input", formatMetric("inputTokens")], ["outputTokens", "Output", formatMetric("outputTokens")], ["cost", "Estimated USD", formatMetric("cost")],
        ]} />
        <nav className="flex flex-wrap items-center justify-between gap-3 text-sm" aria-label="Request pagination">
          <span>Page {result.pagination.page} of {Math.max(1, result.pagination.totalPages)} · {formatReportValue(result.pagination.total, "requests")} requests</span>
          <div className="flex gap-2">
            <button className={buttonClass} disabled={result.pagination.page <= 1} onClick={() => requestReport({ ...query, page: result.pagination.page - 1, cutoff: result.cutoff })}>Previous</button>
            <button className={buttonClass} disabled={result.pagination.page >= result.pagination.totalPages} onClick={() => requestReport({ ...query, page: result.pagination.page + 1, cutoff: result.cutoff })}>Next</button>
          </div>
        </nav>
      </>}
    </>}
  </section>;
}
