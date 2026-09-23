import { NextResponse } from "next/server";
import {
  getSettings,
  updateContextWindowOverrides,
} from "@/lib/db/repos/settingsRepo.js";
import {
  getCapabilitiesForModel,
  getStaticCapabilitiesForModel,
  setContextWindowOverrides,
} from "open-sse/providers/capabilities.js";
import { resolveProviderAlias } from "open-sse/services/model.js";
import { AI_MODELS } from "@/shared/constants/models.js";
import { getProviderAlias } from "@/shared/constants/providers.js";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const HEADERS = { "Cache-Control": "no-store" };
const MIN_CONTEXT_WINDOW = 1024;
const MAX_CONTEXT_WINDOW = 10_000_000;

function canonicalKey(provider, model) {
  return `${resolveProviderAlias(provider)}/${model}`;
}

function registeredModels() {
  const seen = new Set();
  return AI_MODELS.flatMap((entry) => {
    const provider = resolveProviderAlias(entry.provider);
    const key = canonicalKey(provider, entry.model);
    if (seen.has(key)) return [];
    seen.add(key);
    const base = getStaticCapabilitiesForModel(provider, entry.model);
    const effective = getCapabilitiesForModel(provider, entry.model);
    return [{
      key,
      provider,
      providerAlias: getProviderAlias(provider),
      model: entry.model,
      name: entry.name || entry.model,
      defaultContextWindow: base.contextWindow,
      effectiveContextWindow: effective.contextWindow,
      maxOutput: effective.maxOutput,
    }];
  }).sort((a, b) => a.key.localeCompare(b.key));
}

function validateKey(key, validKeys) {
  return typeof key === "string" && validKeys.has(key);
}

function validateWindow(value) {
  return Number.isSafeInteger(value)
    && value >= MIN_CONTEXT_WINDOW
    && value <= MAX_CONTEXT_WINDOW;
}

async function syncRuntime(overrides) {
  setContextWindowOverrides(overrides);
}

export async function GET() {
  try {
    const settings = await getSettings();
    const overrides = settings.contextWindowOverrides || {};
    await syncRuntime(overrides);
    return NextResponse.json({
      models: registeredModels(),
      overrides,
      limits: { min: MIN_CONTEXT_WINDOW, max: MAX_CONTEXT_WINDOW },
    }, { headers: HEADERS });
  } catch (error) {
    console.log("Error getting model context settings:", error);
    return NextResponse.json({ error: "Failed to load model context settings" }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const body = await request.json();
    const set = Array.isArray(body?.set) ? body.set : [];
    const deleteKeys = Array.isArray(body?.deleteKeys) ? body.deleteKeys : [];
    if (set.length + deleteKeys.length === 0) {
      return NextResponse.json({ error: "At least one change is required" }, { status: 400 });
    }

    const validKeys = new Set(registeredModels().map((model) => model.key));
    for (const item of set) {
      if (!item || !validateKey(item.key, validKeys)) {
        return NextResponse.json({ error: "Unknown provider/model key" }, { status: 400 });
      }
      if (!validateWindow(item.contextWindow)) {
        return NextResponse.json({
          error: `Context window must be an integer from ${MIN_CONTEXT_WINDOW} to ${MAX_CONTEXT_WINDOW}`,
        }, { status: 400 });
      }
    }
    for (const key of deleteKeys) {
      if (!validateKey(key, validKeys)) {
        return NextResponse.json({ error: "Unknown provider/model key" }, { status: 400 });
      }
    }

    const overrides = await updateContextWindowOverrides({ set, deleteKeys });
    await syncRuntime(overrides);
    return NextResponse.json({ success: true, overrides }, { headers: HEADERS });
  } catch (error) {
    if (error instanceof SyntaxError) {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    console.log("Error updating model context settings:", error);
    return NextResponse.json({ error: "Failed to update model context settings" }, { status: 500 });
  }
}
