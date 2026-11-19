"use client";

import { useState } from "react";
import PropTypes from "prop-types";
import { Button, Modal, Select, Toggle } from "@/shared/components";
import {
  CUSTOM_PROFILES,
  THINKING_WIRES,
  OVERRIDE_BOOL_KEYS,
  OVERRIDE_NUM_KEYS,
  OVERRIDE_NUM_MIN,
  OVERRIDE_NUM_MAX,
  sanitizeCapsProfile,
  applyCustomProfile,
} from "open-sse/providers/customCaps.js";
import { getCapabilitiesForModel, DEFAULT_CAPABILITIES } from "open-sse/providers/capabilities.js";
import { extractContextLength } from "@/shared/utils/contextLength";

const PROFILE_LABELS = {
  auto: "Auto (detect from name)",
  qwen: "Qwen",
  claude: "Claude",
  openai: "OpenAI (GPT)",
  gemini: "Gemini",
  text: "Text only",
};

const WIRE_LABELS = {
  auto: "Auto (from profile / provider)",
  vllm: "vLLM (chat_template_kwargs.enable_thinking)",
  openai: "OpenAI (reasoning_effort)",
  "qwen-dashscope": "Qwen DashScope (enable_thinking)",
  none: "None (never send thinking params)",
};

const BOOL_LABELS = {
  vision: "Vision",
  pdf: "PDF",
  videoInput: "Video input",
  reasoning: "Reasoning",
  tools: "Tools",
};

const NUM_LABELS = { contextWindow: "Context window", maxOutput: "Max output" };

function draftFromProfile(capsProfile) {
  const clean = sanitizeCapsProfile(capsProfile);
  const overrides = clean?.overrides || {};
  return {
    profile: clean?.profile || "auto",
    thinkingWire: clean?.thinkingWire || "auto",
    bools: Object.fromEntries(OVERRIDE_BOOL_KEYS.filter((k) => k in overrides).map((k) => [k, overrides[k]])),
    nums: Object.fromEntries(OVERRIDE_NUM_KEYS.map((k) => [k, k in overrides ? String(overrides[k]) : ""])),
  };
}

function parseNum(text) {
  const t = String(text ?? "").trim();
  if (!t) return { value: undefined, error: null };
  if (!/^\d+$/.test(t)) return { value: undefined, error: "Must be a whole number" };
  const n = Number(t);
  if (n < OVERRIDE_NUM_MIN || n > OVERRIDE_NUM_MAX) {
    return { value: undefined, error: `Must be between ${OVERRIDE_NUM_MIN} and ${OVERRIDE_NUM_MAX}` };
  }
  return { value: n, error: null };
}

function draftToEntry(draft) {
  const overrides = { ...draft.bools };
  for (const key of OVERRIDE_NUM_KEYS) {
    const { value } = parseNum(draft.nums[key]);
    if (value !== undefined) overrides[key] = value;
  }
  return { profile: draft.profile, thinkingWire: draft.thinkingWire, overrides };
}

export default function CustomCapsModal({ isOpen, modelId, providerAlias, capsProfile, connections, onSaved, onClose }) {
  const [draft, setDraft] = useState(() => draftFromProfile(capsProfile));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [detect, setDetect] = useState({ status: null, message: "" });
  // Draft is seeded once from capsProfile; parent mounts this modal per-open (keyed by model).

  const entry = draftToEntry(draft);
  const detected = getCapabilitiesForModel(null, modelId);
  const preview = applyCustomProfile(detected, entry, DEFAULT_CAPABILITIES);
  const numErrors = Object.fromEntries(OVERRIDE_NUM_KEYS.map((k) => [k, parseNum(draft.nums[k]).error]));
  const hasNumError = Object.values(numErrors).some(Boolean);
  const activeConnection = (connections || []).find((c) => c.isActive !== false);

  const handleDetect = async () => {
    if (!activeConnection) return;
    setDetect({ status: "loading", message: "" });
    try {
      const res = await fetch(`/api/providers/${encodeURIComponent(activeConnection.id)}/models`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setDetect({ status: "error", message: typeof data.error === "string" ? data.error : `Request failed (${res.status})` });
        return;
      }
      const len = extractContextLength(data.models, modelId);
      if (len === null) {
        setDetect({ status: "none", message: "Server did not report a context length for this model." });
        return;
      }
      const clamped = Math.min(Math.max(len, OVERRIDE_NUM_MIN), OVERRIDE_NUM_MAX);
      setDraft((d) => ({ ...d, nums: { ...d.nums, contextWindow: String(clamped) } }));
      setDetect({ status: "ok", message: `Detected context length: ${len.toLocaleString()}` });
    } catch {
      setDetect({ status: "error", message: "Could not reach the provider /models endpoint." });
    }
  };

  const handleSave = async (clear = false) => {
    if (saving || (!clear && hasNumError)) return;
    setSaving(true);
    setError("");
    try {
      const body = {
        providerAlias,
        id: modelId,
        type: "llm",
        capsProfile: clear ? null : sanitizeCapsProfile(entry),
      };
      const res = await fetch("/api/models/custom", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(typeof data.error === "string" ? data.error : `Save failed (${res.status})`);
        return;
      }
      if (typeof window !== "undefined") window.dispatchEvent(new Event("customModelChanged"));
      await onSaved?.();
      onClose();
    } catch {
      setError("Save failed: network error");
    } finally {
      setSaving(false);
    }
  };

  const previewParts = [
    ...OVERRIDE_BOOL_KEYS.filter((k) => preview[k]).map((k) => BOOL_LABELS[k]),
    `ctx ${Number(preview.contextWindow).toLocaleString()}`,
    `out ${Number(preview.maxOutput).toLocaleString()}`,
    `thinking: ${preview.reasoning ? (preview.thinkingFormat || "provider default") : "off"}`,
  ];

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Model capabilities">
      <div className="flex flex-col gap-4">
        <p className="text-xs text-text-muted">
          <code className="font-mono bg-sidebar px-1 rounded">{providerAlias}/{modelId}</code>
        </p>

        <Select
          label="Profile"
          value={draft.profile}
          options={CUSTOM_PROFILES.map((p) => ({ value: p, label: PROFILE_LABELS[p] || p }))}
          onChange={(e) => setDraft((d) => ({ ...d, profile: e.target.value }))}
          disabled={saving}
          hint="Template the model behaves like. Auto keeps name-based detection."
        />

        <Select
          label="Thinking wire"
          value={draft.thinkingWire}
          options={THINKING_WIRES.map((w) => ({ value: w, label: WIRE_LABELS[w] || w }))}
          onChange={(e) => setDraft((d) => ({ ...d, thinkingWire: e.target.value }))}
          disabled={saving}
          hint="How thinking parameters are sent upstream."
        />

        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label className="text-sm font-medium">Capabilities</label>
            <button
              type="button"
              onClick={() => setDraft((d) => ({ ...d, bools: {}, nums: Object.fromEntries(OVERRIDE_NUM_KEYS.map((k) => [k, ""])) }))}
              className="text-xs text-text-muted hover:text-primary"
              disabled={saving}
            >
              Reset overrides
            </button>
          </div>
          <div className="flex flex-wrap gap-4">
            {OVERRIDE_BOOL_KEYS.map((key) => (
              <Toggle
                key={key}
                checked={!!preview[key]}
                onChange={(v) => setDraft((d) => ({ ...d, bools: { ...d.bools, [key]: v } }))}
                label={key in draft.bools ? `${BOOL_LABELS[key]} *` : BOOL_LABELS[key]}
                size="sm"
                disabled={saving}
              />
            ))}
          </div>
          <p className="text-xs text-text-muted mt-1">* = overridden</p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          {OVERRIDE_NUM_KEYS.map((key) => (
            <div key={key}>
              <label htmlFor={`caps-${key}`} className="text-sm font-medium mb-1.5 block">{NUM_LABELS[key]}</label>
              <input
                id={`caps-${key}`}
                type="text"
                inputMode="numeric"
                value={draft.nums[key]}
                onChange={(e) => setDraft((d) => ({ ...d, nums: { ...d.nums, [key]: e.target.value } }))}
                placeholder={String(preview[key])}
                disabled={saving}
                className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-background focus:outline-none focus:border-primary"
              />
              {numErrors[key] && <p className="text-xs text-red-500 mt-1">{numErrors[key]}</p>}
            </div>
          ))}
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <Button
            variant="secondary"
            size="sm"
            icon="travel_explore"
            onClick={handleDetect}
            disabled={!activeConnection || detect.status === "loading" || saving}
            loading={detect.status === "loading"}
          >
            Detect from server
          </Button>
          {!activeConnection && <span className="text-xs text-text-muted">Add an active connection to detect.</span>}
          {detect.message && (
            <span className={`text-xs ${detect.status === "error" ? "text-red-500" : detect.status === "ok" ? "text-green-600" : "text-text-muted"}`}>
              {detect.message}
            </span>
          )}
        </div>

        <div className="text-xs text-text-muted bg-sidebar rounded-lg px-3 py-2">
          <span className="font-medium">Preview:</span> {previewParts.join(" · ")}
        </div>

        {error && (
          <div className="flex items-start gap-2 text-sm text-red-500">
            <span className="material-symbols-outlined text-base shrink-0">cancel</span>
            <span>{error}</span>
          </div>
        )}

        <div className="flex gap-2 pt-1">
          <Button onClick={() => handleSave(true)} variant="ghost" size="sm" disabled={saving}>Clear</Button>
          <Button onClick={onClose} variant="ghost" fullWidth size="sm" disabled={saving}>Cancel</Button>
          <Button onClick={() => handleSave(false)} fullWidth size="sm" disabled={saving || hasNumError}>
            {saving ? "Saving..." : "Save"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

CustomCapsModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  modelId: PropTypes.string.isRequired,
  providerAlias: PropTypes.string.isRequired,
  capsProfile: PropTypes.object,
  connections: PropTypes.arrayOf(PropTypes.shape({
    id: PropTypes.string,
    isActive: PropTypes.bool,
  })),
  onSaved: PropTypes.func,
  onClose: PropTypes.func.isRequired,
};
