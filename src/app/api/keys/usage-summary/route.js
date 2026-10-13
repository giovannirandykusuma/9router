import { NextResponse } from "next/server";
import { getApiKeys } from "@/lib/db/repos/apiKeysRepo.js";
import { getKeyUsageSummary } from "@/lib/db/repos/usageRepo.js";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json({ usage: await getKeyUsageSummary(await getApiKeys()) });
  } catch {
    return NextResponse.json({ error: "Failed to fetch key usage" }, { status: 500 });
  }
}
