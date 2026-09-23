"use client";

import { useEffect, useMemo, useState } from "react";
import { Button, Card, Input } from "@/shared/components";
import { invalidateModelCaps } from "@/shared/hooks/useModelCaps.js";

const formatTokens = (value) => Number(value || 0).toLocaleString();

export default function ModelContextPage() {
  const [models, setModels] = useState([]);
  const [overrides, setOverrides] = useState({});
  const [limits, setLimits] = useState({ min: 1024, max: 10_000_000 });
  const [drafts, setDrafts] = useState({});
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [savingKey, setSavingKey] = useState(null);
  const [message, setMessage] = useState(null);

  async function load() {
    setLoading(true);
    try {
      const response = await fetch("/api/model-context", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Unable to load model contexts");
      setModels(data.models || []);
      setOverrides(data.overrides || {});
      setLimits(data.limits || limits);
    } catch (error) {
      setMessage({ type: "error", text: error.message });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const timer = setTimeout(() => load(), 0);
    return () => clearTimeout(timer);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return models;
    return models.filter((item) =>
      `${item.provider} ${item.providerAlias} ${item.model} ${item.name}`.toLowerCase().includes(needle)
    );
  }, [models, query]);

  async function mutate(payload, key) {
    setSavingKey(key);
    setMessage(null);
    try {
      const response = await fetch("/api/model-context", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Unable to save context window");
      invalidateModelCaps();
      await load();
      setDrafts((current) => { const next = { ...current }; delete next[key]; return next; });
      setMessage({ type: "success", text: payload.deleteKeys ? "Reset to the registered default." : "Context window saved." });
    } catch (error) {
      setMessage({ type: "error", text: error.message });
    } finally {
      setSavingKey(null);
    }
  }

  function save(row) {
    const value = Number(drafts[row.key] ?? row.effectiveContextWindow);
    if (!Number.isSafeInteger(value) || value < limits.min || value > limits.max) {
      setMessage({ type: "error", text: `Enter a whole number from ${formatTokens(limits.min)} to ${formatTokens(limits.max)}.` });
      return;
    }
    mutate({ set: [{ key: row.key, contextWindow: value }] }, row.key);
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-text-primary">Model Context</h1>
        <p className="mt-1 text-sm text-text-muted">
          Override the total context window for one provider and model. Output limits are shown separately and are not changed.
        </p>
      </div>

      <Card className="p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search provider or model"
            className="sm:max-w-sm"
          />
          <div className="text-xs text-text-muted">
            Valid range: {formatTokens(limits.min)}–{formatTokens(limits.max)} tokens
          </div>
        </div>
        {message && (
          <div className={`mt-3 rounded-lg px-3 py-2 text-sm ${message.type === "error" ? "bg-red-500/10 text-red-500" : "bg-green-500/10 text-green-600"}`}>
            {message.text}
          </div>
        )}
      </Card>

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-border-subtle bg-surface-2 text-left text-xs uppercase tracking-wide text-text-muted">
              <tr>
                <th className="px-4 py-3">Provider / model</th>
                <th className="px-4 py-3 text-right">Default</th>
                <th className="px-4 py-3 text-right">Effective</th>
                <th className="px-4 py-3 text-right">Max output</th>
                <th className="px-4 py-3">Override</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {loading ? (
                <tr><td colSpan="6" className="px-4 py-12 text-center text-text-muted">Loading model contexts…</td></tr>
              ) : visible.length === 0 ? (
                <tr><td colSpan="6" className="px-4 py-12 text-center text-text-muted">No models found.</td></tr>
              ) : visible.map((row) => {
                const overridden = Object.prototype.hasOwnProperty.call(overrides, row.key);
                return (
                  <tr key={row.key} className="hover:bg-surface-2/50">
                    <td className="px-4 py-3">
                      <div className="font-medium text-text-primary">{row.name}</div>
                      <div className="font-mono text-xs text-text-muted">{row.providerAlias}/{row.model}</div>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-text-muted">{formatTokens(row.defaultContextWindow)}</td>
                    <td className={`px-4 py-3 text-right font-medium tabular-nums ${overridden ? "text-amber-600" : "text-text-primary"}`}>
                      {formatTokens(row.effectiveContextWindow)}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-text-muted">{formatTokens(row.maxOutput)}</td>
                    <td className="px-4 py-3">
                      <Input
                        type="number"
                        min={limits.min}
                        max={limits.max}
                        step="1"
                        value={drafts[row.key] ?? row.effectiveContextWindow}
                        onChange={(event) => setDrafts((current) => ({ ...current, [row.key]: event.target.value }))}
                        className="w-40 font-mono"
                        aria-label={`Context window for ${row.key}`}
                      />
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-2">
                        <Button size="sm" onClick={() => save(row)} disabled={savingKey === row.key}>Save</Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => mutate({ deleteKeys: [row.key] }, row.key)}
                          disabled={!overridden || savingKey === row.key}
                          title="Remove this override and use the registered default"
                        >Reset</Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
