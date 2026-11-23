import { NextResponse } from "next/server";
import { getCustomModels, addCustomModel, deleteCustomModel, setCustomModelCapsProfile } from "@/models";
import { refreshCustomCaps } from "@/lib/customCapsLoader.js";
import { isOpenAICompatibleProvider, isAnthropicCompatibleProvider } from "@/shared/constants/providers";
import { sanitizeCapsProfile } from "open-sse/providers/customCaps.js";
import { CAPACITY_META, isSttTransport } from "@/shared/constants/models";

export const dynamic = "force-dynamic";

// Whitelist capability keys to boolean values — ignore anything else
function sanitizeCaps(caps) {
  if (!caps || typeof caps !== "object") return null;
  const clean = {};
  for (const key of Object.keys(CAPACITY_META)) {
    if (typeof caps[key] === "boolean") clean[key] = caps[key];
  }
  return Object.keys(clean).length ? clean : null;
}

// Accepted STT transport markers live in the shared whitelist
// (src/shared/constants/models STT_TRANSPORT_META) — the dashboard transport
// select and this validator must agree on one set, so neither owns a copy.
// Unknown or mistyped values are silently dropped, the same policy
// sanitizeCaps applies to capability keys.
function sanitizeTransport(transport, type) {
  if (type !== "stt" || !isSttTransport(transport)) return null;
  return transport.trim();
}

function sanitizeUpstreamModelId(upstreamModelId) {
  if (typeof upstreamModelId !== "string") return null;
  const trimmed = upstreamModelId.trim();
  if (!trimmed || trimmed.length > 256 || /[\r\n\0]/.test(trimmed)) return null;
  return trimmed;
}

// GET /api/models/custom - List all custom models
export async function GET() {
  try {
    const models = await getCustomModels();
    return NextResponse.json({ models });
  } catch (error) {
    console.log("Error fetching custom models:", error);
    return NextResponse.json({ error: "Failed to fetch custom models" }, { status: 500 });
  }
}

// POST /api/models/custom - Add custom model
export async function POST(request) {
  try {
    const { providerAlias, id, type, name, caps, transport, upstreamModelId } = await request.json();
    if (!providerAlias || !id) {
      return NextResponse.json({ error: "providerAlias and id required" }, { status: 400 });
    }
    const cleanCaps = sanitizeCaps(caps);
    const cleanTransport = sanitizeTransport(transport, type || "llm");
    const cleanUpstreamModelId = sanitizeUpstreamModelId(upstreamModelId);
    const added = await addCustomModel({
      providerAlias,
      id,
      type: type || "llm",
      name,
      ...(cleanCaps ? { caps: cleanCaps } : {}),
      ...(cleanTransport ? { transport: cleanTransport } : {}),
      ...(cleanUpstreamModelId ? { upstreamModelId: cleanUpstreamModelId } : {}),
    });
    return NextResponse.json({ success: true, added });
  } catch (error) {
    console.log("Error adding custom model:", error);
    return NextResponse.json({ error: "Failed to add custom model" }, { status: 500 });
  }
}

// PATCH /api/models/custom - Set or clear the profile on an existing compatible LLM
export async function PATCH(request) {
  const body = await request.json().catch(() => null);
  const { providerAlias, id, type = "llm", capsProfile } = body ?? {};
  if (typeof providerAlias !== "string" || !providerAlias || providerAlias.includes("|") ||
      typeof id !== "string" || !id.trim() || id.includes("|")) {
    return NextResponse.json({ error: "Valid providerAlias and id required" }, { status: 400 });
  }
  if (type !== "llm" || (!isOpenAICompatibleProvider(providerAlias) && !isAnthropicCompatibleProvider(providerAlias))) {
    return NextResponse.json({ error: "Capability profiles require a compatible LLM" }, { status: 400 });
  }
  if (capsProfile !== null && (typeof capsProfile !== "object" || Array.isArray(capsProfile))) {
    return NextResponse.json({ error: "capsProfile must be an object or null" }, { status: 400 });
  }
  const clean = sanitizeCapsProfile(capsProfile);
  try {
    const updated = await setCustomModelCapsProfile({ providerAlias, id, type, capsProfile: clean });
    if (!updated) return NextResponse.json({ error: "Custom model not found" }, { status: 404 });
    await refreshCustomCaps().catch(() => {});
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: "Failed to update custom model capability profile" }, { status: 500 });
  }
}

// DELETE /api/models/custom?providerAlias=xxx&id=yyy&type=zzz
export async function DELETE(request) {
  try {
    const { searchParams } = new URL(request.url);
    const providerAlias = searchParams.get("providerAlias");
    const id = searchParams.get("id");
    const type = searchParams.get("type") || "llm";
    if (!providerAlias || !id) {
      return NextResponse.json({ error: "providerAlias and id required" }, { status: 400 });
    }
    await deleteCustomModel({ providerAlias, id, type });
    await refreshCustomCaps().catch(() => {});
    return NextResponse.json({ success: true });
  } catch (error) {
    console.log("Error deleting custom model:", error);
    return NextResponse.json({ error: "Failed to delete custom model" }, { status: 500 });
  }
}
