// Who may create or reveal a raw MCP gateway key.
// Local requests, or a request carrying a valid signed dashboard session cookie
// (i.e. the owner logged in on the public dashboard). The `requireLogin: false`
// settings bypass is deliberately NOT accepted here: a raw key is a bearer
// secret for every granted MCP server. The cookie is SameSite=Lax, so a
// cross-site POST cannot ride the session.
import { isLocalRequest } from "@/dashboardGuard";
import { verifyDashboardAuthToken } from "@/lib/auth/dashboardSession";

export async function canManageRawGatewayKeys(request) {
  if (isLocalRequest(request)) return true;
  const token = request.cookies?.get?.("auth_token")?.value;
  if (!token) return false;
  return !!(await verifyDashboardAuthToken(token));
}
