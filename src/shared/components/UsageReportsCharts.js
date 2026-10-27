"use client";

import { useState } from "react";
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, BarChart, Bar } from "recharts";
import Card from "./Card";

const series = { requests: "Requests", totalTokens: "Tokens", cost: "Estimated USD" };
export default function UsageReportsCharts({ daily, byModel, timezone }) {
  const [metric, setMetric] = useState("requests");
  const models = [...byModel].sort((a, b) => b.requests - a.requests).slice(0, 10).map((row) => ({ ...row, label: `${row.provider || "Unknown"}/${row.model || "Unknown"}` }));
  return <div className="grid min-w-0 grid-cols-1 gap-4 xl:grid-cols-2" data-testid="report-charts">
    <Card className="min-w-0" padding="sm">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold">Daily usage</h3>
        <select aria-label="Chart metric" value={metric} onChange={(e) => setMetric(e.target.value)} className="rounded-lg border border-border bg-bg px-2 py-1 text-xs">{Object.entries(series).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>
      </div>
      <p className="mb-2 text-xs text-text-muted">{timezone} · {series[metric]} · known values only</p>
      <div className="h-64 min-w-0 overflow-hidden" role="img" aria-label={`Daily ${series[metric]} chart in ${timezone}`}>
        <ResponsiveContainer width="100%" height="100%" minWidth={0}>
          <LineChart data={daily} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" opacity={0.15} />
            <XAxis dataKey="date" tick={{ fontSize: 10 }} tickFormatter={(value) => value.slice(5)} />
            <YAxis width={52} tick={{ fontSize: 10 }} />
            <Tooltip contentStyle={{ background: "var(--color-bg, #fff)", borderColor: "var(--color-border, #ddd)", borderRadius: 8 }} />
            <Line type="monotone" dataKey={metric} name={series[metric]} stroke="var(--color-primary, #f97316)" strokeWidth={2} dot={daily.length === 1 ? { r: 3 } : false} connectNulls={false} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </Card>
    <Card className="min-w-0" padding="sm">
      <h3 className="mb-2 font-semibold">Top models</h3>
      <p className="mb-4 text-xs text-text-muted">Top 10 by recorded requests · all models included in XLSX</p>
      <div className="h-64 min-w-0 overflow-hidden" role="img" aria-label="Requests by model chart">
        <ResponsiveContainer width="100%" height="100%" minWidth={0}>
          <BarChart data={models} layout="vertical" margin={{ top: 0, right: 12, bottom: 0, left: 0 }}>
            <XAxis type="number" tick={{ fontSize: 10 }} />
            <YAxis dataKey="label" type="category" width={115} tick={{ fontSize: 10 }} tickFormatter={(value) => value.length > 19 ? `${value.slice(0, 18)}…` : value} />
            <Tooltip contentStyle={{ background: "var(--color-bg, #fff)", borderColor: "var(--color-border, #ddd)", borderRadius: 8 }} />
            <Bar dataKey="requests" name="Requests" fill="var(--color-primary, #f97316)" radius={[0, 3, 3, 0]} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </Card>
  </div>;
}
