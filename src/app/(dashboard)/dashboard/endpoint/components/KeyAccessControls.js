"use client";

import { useEffect, useState } from "react";
import PropTypes from "prop-types";
import { Toggle, ModelSelectModal } from "@/shared/components";
import { AI_PROVIDERS } from "@/shared/constants/providers";

// Independent allowlists: provider + account + model/combo, intersected by the
// engine. Keep missing account IDs visible so deleting an account cannot
// silently change a specific-account policy into all accounts.
export default function KeyAccessControls({ apiKey, onChange, onRequestRestrict }) {
  const access = apiKey.access || { restricted: false, allow: [] };
  const { restricted = false, allow = [], allowedProviders = [], allowedConnections = [] } = access;
  const [showPicker, setShowPicker] = useState(false);
  const [connections, setConnections] = useState([]);
  const [nodes, setNodes] = useState([]);
  const [loadError, setLoadError] = useState(false);
  const [modelAliases, setModelAliases] = useState({});
  const openPicker = async () => {
    setShowPicker(true);
    try {
      const response = await fetch("/api/models/alias");
      if (response.ok) setModelAliases((await response.json()).aliases || {});
    } catch { setLoadError(true); }
  };
  useEffect(() => {
    if (!restricted) return;
    let cancelled = false;
    Promise.all([fetch("/api/providers"), fetch("/api/provider-nodes")])
      .then(async ([accounts, providers]) => {
        if (!accounts.ok || !providers.ok) throw new Error("Unable to load accounts");
        return Promise.all([accounts.json(), providers.json()]);
      })
      .then(([accounts, providers]) => {
        if (cancelled) return;
        setConnections(accounts.connections || []);
        setNodes(providers.nodes || []);
        setLoadError(false);
      })
      .catch(() => { if (!cancelled) setLoadError(true); });
    return () => { cancelled = true; };
  }, [restricted]);
  const update = (patch) => onChange({ ...access, ...patch });
  const toggle = (values, value) => values.includes(value) ? values.filter((v) => v !== value) : [...values, value];
  const providerIds = [...new Set([...connections.map((c) => c.provider), ...allowedProviders])].sort();
  const providerName = (id) => nodes.find((n) => n.id === id)?.name || AI_PROVIDERS[id]?.name || id;
  const missing = allowedConnections.filter((id) => !connections.some((c) => c.id === id));
  const empty = !allow.length && !allowedProviders.length && !allowedConnections.length;
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs text-text-muted">Restrict access</span>
        <Toggle checked={restricted} size="sm" onChange={() => restricted
          ? update({ restricted: false }) : onRequestRestrict(apiKey)} />
      </div>
      {restricted && (
        <div className="space-y-3">
          {empty && <p className="text-xs text-amber-600 dark:text-amber-400">Nothing allowed — this key cannot call any model until access is selected.</p>}
          <p className="text-xs text-text-muted">Selected providers, accounts, and models are combined as restrictions. Leave a section empty for no additional restriction.</p>
          {loadError && <p className="text-xs text-red-500">Could not load accounts. Saved restrictions remain unchanged.</p>}
          <fieldset className="space-y-1">
            <legend className="text-xs font-medium text-text-muted">Providers {allowedProviders.length ? `(${allowedProviders.length})` : "(all)"}</legend>
            {providerIds.map((id) => (
              <label key={id} className="flex items-center gap-2 text-xs">
                <input type="checkbox" checked={allowedProviders.includes(id)} onChange={() => update({ allowedProviders: toggle(allowedProviders, id) })} />
                {providerName(id)}
              </label>
            ))}
          </fieldset>
          <fieldset className="space-y-1">
            <legend className="text-xs font-medium text-text-muted">Accounts {allowedConnections.length ? `(${allowedConnections.length} selected only)` : "(all within allowed providers)"}</legend>
            <p className="text-xs text-text-muted">Selecting any account excludes every other account. Unavailable or deleted accounts never fall back to an unselected account.</p>
            {connections.map((c) => (
              <label key={c.id} className="flex items-center gap-2 text-xs">
                <input type="checkbox" checked={allowedConnections.includes(c.id)} onChange={() => update({ allowedConnections: toggle(allowedConnections, c.id) })} />
                {providerName(c.provider)} — {c.name || c.email || c.id}{c.isActive === false ? " (inactive)" : ""}
              </label>
            ))}
            {missing.map((id) => (
              <label key={id} className="flex items-center gap-2 text-xs text-amber-600">
                <input type="checkbox" checked onChange={() => update({ allowedConnections: allowedConnections.filter((v) => v !== id) })} />
                Unavailable account ({id}) — still restricted
              </label>
            ))}
          </fieldset>
          <div className="space-y-2">
            <span className="text-xs font-medium text-text-muted">Models &amp; combos {allow.length ? `(${allow.length})` : "(all within provider/account scope)"}</span>
            <div className="flex flex-wrap gap-1.5">
              {allow.map((entry) => (
                <span key={entry} className="inline-flex items-center gap-1 rounded bg-primary/10 px-2 py-0.5 text-xs font-mono">
                  {entry}
                  <button type="button" aria-label={`Remove ${entry}`} onClick={() => update({ allow: allow.filter((v) => v !== entry) })} className="text-text-muted hover:text-red-500">×</button>
                </span>
              ))}
              <button type="button" onClick={openPicker} className="rounded border border-dashed border-border px-2 py-0.5 text-xs text-text-muted hover:border-primary hover:text-primary">+ Add models / combos</button>
            </div>
          </div>
        </div>
      )}
      {showPicker && (
        <ModelSelectModal isOpen onClose={() => setShowPicker(false)} addedModelValues={allow}
          activeProviders={connections} modelAliases={modelAliases}
          onSelect={(model) => {
            const value = model?.value;
            if (value && !allow.some((entry) => entry.toLowerCase() === value.toLowerCase())) {
              update({ allow: [...allow, value] });
            }
          }}
          title={`Allowed models for ${apiKey.name || "key"}`} />
      )}
    </div>
  );
}

KeyAccessControls.propTypes = {
  apiKey: PropTypes.object.isRequired,
  onChange: PropTypes.func.isRequired,
  onRequestRestrict: PropTypes.func.isRequired,
};
