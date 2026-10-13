import { NextResponse } from "next/server";
import { getGatewayKeys } from "@/lib/db/repos/mcpGatewayRepo.js";
import { getKeyUsageSummary } from "@/lib/db/repos/usageRepo.js";

export const dynamic = "force-dynamic";

// Dashboard-only: this static keys route is not part of the MCP protocol surface.
export async function GET() {
  try {
    return NextResponse.json({ usage: await getKeyUsageSummary(await getGatewayKeys(), { gateway: true }) });
  } catch {
    return NextResponse.json({ error: "Failed to fetch gateway key usage" }, { status: 500 });
  }
}
