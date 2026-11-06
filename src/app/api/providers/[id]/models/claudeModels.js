import claudeProvider from "open-sse/providers/registry/claude.js";

// Discovery uses the same credential contract as inference. Never fall through
// to the other credential when an explicit authType has no usable token.
export async function resolveClaudeModels(connection) {
  const authType = connection.authType || (connection.accessToken ? "oauth" : "apikey");
  const oauth = authType === "oauth";
  const token = oauth ? connection.accessToken : authType === "apikey" ? connection.apiKey : null;
  if (!token) return { error: "No valid token found", status: 401 };

  const auth = claudeProvider.transport.auth[oauth ? "oauth" : "apiKey"];
  const headers = {
    "Anthropic-Version": claudeProvider.transport.headers["Anthropic-Version"],
    "Content-Type": "application/json",
    [auth.header]: `${auth.scheme === "bearer" ? "Bearer " : ""}${token}`,
  };
  if (oauth) headers["Anthropic-Beta"] = "oauth-2025-04-20";

  try {
    const response = await fetch("https://api.anthropic.com/v1/models", {
      method: "GET", headers, redirect: "error",
    });
    // Neither upstream response bodies nor fetch errors are safe to expose:
    // proxies can echo request headers (including credentials) in either.
    if (!response.ok) return { error: `Failed to fetch models: ${response.status}`, status: response.status };
    const data = await response.json();
    return { models: Array.isArray(data?.data) ? data.data : [] };
  } catch {
    return { error: "Failed to fetch Claude models", status: 502 };
  }
}
