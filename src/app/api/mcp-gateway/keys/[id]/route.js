import { NextResponse } from "next/server";
import { canManageRawGatewayKeys } from "@/lib/mcp/gateway/keyAccess";
import {
  getGatewayKeyById,
  deleteGatewayKey,
  getGrantsForKeyDetailed,
  setGrants,
} from "@/lib/localDb";

export const dynamic = "force-dynamic";

function stripKey(k) {
  if (!k) return k;
  const { key: _key, ...rest } = k;
  void _key;
  return rest;
}

export async function GET(request, context) {
  try {
    const { id } = await context.params;
    const k = await getGatewayKeyById(id);
    if (!k) return NextResponse.json({ error: "not found" }, { status: 404 });
    const grants = await getGrantsForKeyDetailed(id);
    const url = new URL(request.url);
    const reveal = url.searchParams.get("reveal") === "1";
    // reveal=1 returns the raw key: local requests or a logged-in dashboard session.
    if (reveal && !(await canManageRawGatewayKeys(request))) {
      return NextResponse.json(
        { error: "Key reveal requires a logged-in dashboard session." },
        { status: 403 }
      );
    }
    return NextResponse.json({ key: reveal ? k : stripKey(k), grants });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function PUT(request, context) {
  try {
    const { id } = await context.params;
    const body = await request.json();
    if (Array.isArray(body.grants)) {
      const grants = body.grants.map((g) => (typeof g === "string" ? g : g?.instanceId)).filter(Boolean);
      const toolAllowlists = Array.isArray(body.toolAllowlists) ? body.toolAllowlists : undefined;
      await setGrants(id, grants, toolAllowlists);
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function DELETE(_request, context) {
  try {
    const { id } = await context.params;
    const ok = await deleteGatewayKey(id);
    if (!ok) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
