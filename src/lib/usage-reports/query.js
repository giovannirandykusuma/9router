import { LIMITS, ReportError, dayBoundaries } from './filters.js';
import { reportCache } from './cache.js';

export const METRICS = ['requests', 'inputTokens', 'outputTokens', 'totalTokens', 'cachedTokens', 'cacheCreationTokens', 'reasoningTokens', 'cost'];
const TOKEN_PATHS = {
  inputTokens: ['prompt_tokens', 'input_tokens'],
  outputTokens: ['completion_tokens', 'output_tokens'],
  cachedTokens: ['cached_tokens', 'cache_read_input_tokens', 'prompt_tokens_details.cached_tokens'],
  cacheCreationTokens: ['cache_creation_input_tokens'],
  reasoningTokens: ['reasoning_tokens', 'completion_tokens_details.reasoning_tokens'],
  totalTokens: ['total_tokens'],
};
// Read evidence from JSON, not the legacy zero-default scalar columns. Guard
// malformed JSON and nonnumeric/negative values before any arithmetic.
function tokenExpression(paths) {
  const values = paths.map((path) => `CASE WHEN json_type(t, '$.${path}') IN ('integer','real')
    AND json_extract(t, '$.${path}') >= 0 AND json_extract(t, '$.${path}') <= 9007199254740991
    THEN json_extract(t, '$.${path}') END`);
  return values.length === 1 ? values[0] : `COALESCE(${values.join(',')})`;
}
const evidenceSql = Object.entries(TOKEN_PATHS).map(([metric, paths]) => `${tokenExpression(paths)} AS ${metric}`).join(',');
const metricColumns = METRICS.filter((m) => m !== 'requests').join(',');
const aggregateSql = `COUNT(*) AS requests, ${METRICS.filter((m) => m !== 'requests').map((m) => `SUM(${m}) AS ${m}, COUNT(${m}) AS known_${m}`).join(',')}`;

export function reportWhere(filters, cutoff) {
  const clauses = ['h.timestamp >= ?', 'h.timestamp < ?', 'h.id <= ?', "(h.provider IS NULL OR h.provider <> 'mcp-gateway')"];
  const params = [filters.startUtc, filters.endUtc, cutoff];
  for (const [filter, column] of [['keyId', 'apiKeyId'], ['provider', 'provider'], ['connectionId', 'connectionId'], ['model', 'model']]) {
    if (filters[filter] !== undefined) { clauses.push(`h.${column} = ?`); params.push(filters[filter]); }
  }
  return { sql: clauses.join(' AND '), params };
}
function metricCte(where) {
  return `WITH source AS (
    SELECT h.id, h.timestamp, h.provider, h.model, h.connectionId,
      h.apiKeyId AS keyId, h.apiKeyName AS keyName,
      COALESCE(NULLIF(c.name, ''), h.connectionId) AS accountName,
      CASE WHEN json_valid(h.tokens) THEN h.tokens ELSE '{}' END AS t,
      CASE WHEN typeof(h.cost) IN ('integer','real') AND h.cost >= 0 AND h.cost < 1e100 THEN h.cost END AS cost
    FROM usageHistory h LEFT JOIN providerConnections c ON c.id = h.connectionId WHERE ${where}
  ), evidence AS MATERIALIZED (SELECT *, ${evidenceSql} FROM source),
  metrics AS (SELECT id, timestamp, provider, model, connectionId, accountName, keyId, keyName,
    inputTokens, outputTokens, COALESCE(totalTokens, inputTokens + outputTokens) AS totalTokens,
    cachedTokens, cacheCreationTokens, reasoningTokens, cost FROM evidence)`;
}
// A balanced CASE maps timestamps to Luxon calendar boundaries in O(log days)
// comparisons without SQLite/server timezone assumptions or per-day scans.
function dayExpression(days, params) {
  if (days.length === 1) { params.push(days[0].date); return '?'; }
  const middle = Math.floor(days.length / 2);
  params.push(days[middle].start);
  const left = dayExpression(days.slice(0, middle), params);
  const right = dayExpression(days.slice(middle), params);
  return `CASE WHEN timestamp < ? THEN ${left} ELSE ${right} END`;
}
function aggregate(row) {
  const result = { ...row, known: { requests: row.requests } };
  for (const metric of METRICS.filter((m) => m !== 'requests')) {
    result.known[metric] = row[`known_${metric}`];
    delete result[`known_${metric}`];
  }
  return result;
}
function options(db, cutoff) {
  // Deliberately independent of selected filters: changing a key never hides the
  // remaining choices. Only allowlisted labels/IDs leave the database.
  const history = "id <= ? AND (provider IS NULL OR provider <> 'mcp-gateway')";
  const keys = db.all(`SELECT id, name FROM apiKeys
    UNION ALL SELECT h.apiKeyId AS id, MAX(h.apiKeyName) AS name FROM usageHistory h
    WHERE ${history} AND h.apiKeyId IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM apiKeys k WHERE k.id = h.apiKeyId)
    GROUP BY h.apiKeyId ORDER BY name, id`, [cutoff]);
  const providers = db.all(`SELECT DISTINCT provider FROM usageHistory WHERE ${history} AND provider IS NOT NULL ORDER BY provider`, [cutoff]).map((r) => r.provider);
  const accounts = db.all(`SELECT h.connectionId AS id, COALESCE(NULLIF(c.name, ''), h.connectionId) AS name
    FROM usageHistory h LEFT JOIN providerConnections c ON c.id = h.connectionId
    WHERE h.id <= ? AND (h.provider IS NULL OR h.provider <> 'mcp-gateway') AND h.connectionId IS NOT NULL
    GROUP BY h.connectionId ORDER BY name, h.connectionId`, [cutoff]);
  const models = db.all(`SELECT DISTINCT provider, model FROM usageHistory WHERE ${history} AND model IS NOT NULL ORDER BY provider, model`, [cutoff]);
  return { keys, providers, accounts, models };
}

// All DB work is synchronous within one read transaction. The durable cutoff
// also keeps subsequent pages/exports stable against new, even backdated, rows.
export function queryReport(db, filters, { fullExport = false } = {}) {
  let report;
  db.transaction(() => {
    const maximum = db.get('SELECT COALESCE(MAX(id), 0) AS cutoff FROM usageHistory').cutoff;
    const cutoff = Math.min(filters.cutoff ?? maximum, maximum);
    const cache = reportCache(db);
    const aggregateKey = JSON.stringify(['aggregate', cutoff, filters.startUtc, filters.endUtc, filters.timezone,
      filters.keyId ?? null, filters.provider ?? null, filters.connectionId ?? null, filters.model ?? null]);
    let aggregates = cache.get(aggregateKey);
    const where = reportWhere(filters, cutoff);
    const count = aggregates?.summary.requests ?? db.get(`SELECT COUNT(*) AS total FROM usageHistory h WHERE ${where.sql}`, where.params).total;
    if (fullExport && filters.exportMode !== 'summary' && count > LIMITS.maxExportRows) throw new ReportError('Export exceeds 50000 requests; narrow the filters', 413);
    if (!aggregates) {
      const cte = metricCte(where.sql);
      const days = dayBoundaries(filters);
      const dayParams = [];
      const bucket = dayExpression(days, dayParams);
      // Materialize token evidence once and reuse it for all four aggregates.
      const groups = db.all(`${cte}
        SELECT 'summary' AS kind, NULL AS date, NULL AS provider, NULL AS model, NULL AS connectionId, NULL AS accountName, NULL AS keyId, NULL AS keyName, ${aggregateSql} FROM metrics
        UNION ALL SELECT 'model', NULL, provider, model, NULL, NULL, NULL, NULL, ${aggregateSql} FROM metrics GROUP BY provider, model
        UNION ALL SELECT 'account', NULL, provider, NULL, connectionId, accountName, NULL, NULL, ${aggregateSql} FROM metrics GROUP BY provider, connectionId, accountName
        UNION ALL SELECT 'key', NULL, NULL, NULL, NULL, NULL, keyId, MAX(keyName), ${aggregateSql} FROM metrics GROUP BY keyId
        UNION ALL SELECT 'day', ${bucket} AS date, NULL, NULL, NULL, NULL, NULL, NULL, ${aggregateSql} FROM metrics GROUP BY date`, [...where.params, ...dayParams]);
      const unpack = (row, fields = []) => {
        const values = Object.fromEntries([...METRICS, ...METRICS.filter((m) => m !== 'requests').map((m) => `known_${m}`), ...fields].map((key) => [key, row[key]]));
        return aggregate(values);
      };
      const summary = unpack(groups.find((row) => row.kind === 'summary'));
      const byModel = groups.filter((row) => row.kind === 'model').map((row) => unpack(row, ['provider', 'model'])).sort((a, b) => b.requests - a.requests);
      const byAccount = groups.filter((row) => row.kind === 'account').map((row) => unpack(row, ['provider', 'connectionId', 'accountName'])).sort((a, b) => b.requests - a.requests);
      const dailyMap = new Map(groups.filter((row) => row.kind === 'day').map((row) => [row.date, unpack(row, ['date'])]));
      const empty = { ...Object.fromEntries(METRICS.map((m) => [m, m === 'requests' ? 0 : null])), known: Object.fromEntries(METRICS.map((m) => [m, 0])) };
      const daily = days.map((day) => dailyMap.get(day.date) || { date: day.date, ...empty });
      const byKey = groups.filter((row) => row.kind === 'key').map((row) => unpack(row, ['keyId', 'keyName'])).sort((a, b) => b.requests - a.requests);
      aggregates = { summary, daily, byModel, byAccount, byKey };
      cache.set(aggregateKey, aggregates);
    }
    const optionsKey = JSON.stringify(['options', cutoff]);
    let choices = cache.get(optionsKey);
    if (!choices) {
      choices = options(db, cutoff);
      cache.set(optionsKey, choices);
    }
    const limit = fullExport ? LIMITS.maxExportRows : filters.pageSize;
    const offset = fullExport ? 0 : (filters.page - 1) * filters.pageSize;
    // Bound the page before parsing JSON, not after materializing all matches.
    const pageCte = metricCte(`h.id IN (SELECT h.id FROM usageHistory h WHERE ${where.sql} ORDER BY timestamp DESC, id DESC LIMIT ? OFFSET ?)`);
    const requests = fullExport && filters.exportMode === 'summary' ? [] : db.all(`${pageCte} SELECT id, timestamp, provider, model, connectionId, accountName, keyId, keyName, 1 AS requests, ${metricColumns}
      FROM metrics ORDER BY timestamp DESC, id DESC`, [...where.params, limit, offset]);
    report = { filters: { ...filters, cutoff }, cutoff, limits: { ...LIMITS }, ...aggregates, requests,
      pagination: { page: filters.page, pageSize: filters.pageSize, total: count, totalPages: Math.ceil(count / filters.pageSize) },
      options: choices };
  });
  return report;
}
