// Never infer an identity from a prefix/mask, or from a gateway credential.
// This helper also seals legacy rows before a key is renamed, rotated or deleted.
export function sealKeyHistory(db, key = null) {
  db.run(`UPDATE usageHistory SET
    apiKeyId = (SELECT k.id FROM apiKeys k WHERE k.key = usageHistory.apiKey),
    apiKeyName = (SELECT k.name FROM apiKeys k WHERE k.key = usageHistory.apiKey)
    WHERE apiKeyId IS NULL AND apiKeyName IS NULL
      AND apiKey IS NOT NULL AND apiKey <> ''
      AND (provider IS NULL OR provider <> 'mcp-gateway')
      AND (SELECT COUNT(*) FROM apiKeys k WHERE k.key = usageHistory.apiKey) = 1
      AND NOT EXISTS (SELECT 1 FROM mcpGatewayKeys g WHERE g.key = usageHistory.apiKey)
      ${key === null ? '' : 'AND apiKey = ?'}`, key === null ? [] : [key]);
}

export function resolveUsageKey(db, key, provider) {
  if (provider === 'mcp-gateway' || typeof key !== 'string' || !key) return null;
  const rows = db.all(`SELECT id, name FROM apiKeys WHERE key = ?
    AND NOT EXISTS (SELECT 1 FROM mcpGatewayKeys WHERE key = ?) LIMIT 2`, [key, key]);
  return rows.length === 1 ? rows[0] : null;
}
