import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TABLES, buildCreateTableSql, SCHEMA_VERSION } from '@/lib/db/schema.js';
import migration from '@/lib/db/migrations/004-usage-attribution.js';
import { normalizeFilters, dayBoundaries } from '@/lib/usage-reports/filters.js';
import { queryReport, METRICS } from '@/lib/usage-reports/query.js';
import { sealKeyHistory, resolveUsageKey } from '@/lib/usage-reports/attribution.js';
import { reportCache, CACHE_LIMITS } from '@/lib/usage-reports/cache.js';

let raw, db;
beforeEach(() => {
  raw = new DatabaseSync(':memory:');
  db = {
    exec: (sql) => raw.exec(sql),
    run: (sql, args = []) => raw.prepare(sql).run(...args),
    get: (sql, args = []) => raw.prepare(sql).get(...args),
    all: (sql, args = []) => raw.prepare(sql).all(...args),
    transaction: (fn) => { raw.exec('SAVEPOINT report'); try { fn(); raw.exec('RELEASE report'); } catch (e) { raw.exec('ROLLBACK TO report; RELEASE report'); throw e; } },
  };
  for (const [name, table] of Object.entries(TABLES)) {
    db.exec(buildCreateTableSql(name, table));
    for (const index of table.indexes || []) db.exec(index);
  }
});
afterEach(() => raw.close());
function filters(extra = {}) {
  return normalizeFilters(new URLSearchParams({ startDate: '2026-03-08', endDate: '2026-03-08', timezone: 'America/New_York', ...extra }));
}
function insert(overrides = {}) {
  const row = { timestamp: '2026-03-08T12:00:00.000Z', provider: 'cx', model: 'model', connectionId: 'account', apiKey: 'raw-secret',
    apiKeyId: 'kenny', apiKeyName: 'Kenny', cost: 0.25, tokens: JSON.stringify({ prompt_tokens: 10, completion_tokens: 5, cached_tokens: 8, cache_creation_input_tokens: 2, reasoning_tokens: 3 }), ...overrides };
  const keys = Object.keys(row);
  return db.run(`INSERT INTO usageHistory (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, Object.values(row));
}

describe('usage report filters, evidence and reconciliation', () => {
  it('validates explicit Excel modes and rejects them on JSON reports', () => {
    const p = new URLSearchParams({ startDate: '2026-03-08', endDate: '2026-03-08', timezone: 'UTC', cutoff: '1', exportMode: 'summary' });
    expect(normalizeFilters(p, { requireCutoff: true }).exportMode).toBe('summary');
    expect(() => normalizeFilters(p)).toThrow(/export mode/);
    p.set('exportMode', 'everything');
    expect(() => normalizeFilters(p, { requireCutoff: true })).toThrow(/export mode/);
  });
  it('aggregates stable key identities across names and retains unattributed history', () => {
    insert({ apiKeyId: 'default', apiKeyName: 'Default' });
    insert({ apiKeyId: 'default', apiKeyName: 'Renamed default' });
    insert({ apiKeyId: 'other', apiKeyName: 'Default' });
    insert({ apiKeyId: null, apiKeyName: null });
    const report = queryReport(db, filters());
    expect(report.byKey).toHaveLength(3);
    expect(report.byKey.find(r => r.keyId === 'default').requests).toBe(2);
    expect(report.byKey.find(r => r.keyId === null).requests).toBe(1);
    expect(report.byKey.reduce((n, r) => n + r.inputTokens, 0)).toBe(report.summary.inputTokens);
    expect(queryReport(db, filters({ keyId: 'default' })).byKey).toHaveLength(1);
  });
  it('exports complete aggregates above the detail cap without reading request pages', () => {
    db.exec(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<50001)
      INSERT INTO usageHistory(timestamp,provider,apiKeyId,apiKeyName,tokens,cost)
      SELECT '2026-03-08T12:00:00.000Z','cx','default','Default','{"prompt_tokens":1,"completion_tokens":2}',0 FROM n`);
    const f = normalizeFilters(new URLSearchParams({ startDate: '2026-03-08', endDate: '2026-03-08', timezone: 'UTC', cutoff: '50001', exportMode: 'summary' }), { requireCutoff: true });
    const report = queryReport(db, f, { fullExport: true });
    expect(report.summary.requests).toBe(50001);
    expect(report.byKey[0].requests).toBe(50001);
    expect(report.requests).toEqual([]);
    expect(() => queryReport(db, { ...f, exportMode: 'details' }, { fullExport: true })).toThrow(/50000/);
  });
  it('excludes MCP from an unfiltered report, including summary, options and requests', () => {
    insert();
    insert({ provider: 'mcp-gateway', model: 'private-tool' });
    const report = queryReport(db, filters());
    expect(report.summary.requests).toBe(1);
    expect(report.requests).toHaveLength(1);
    expect(report.options.providers).toEqual(['cx']);
    expect(report.options.models).not.toContainEqual({ provider: 'mcp-gateway', model: 'private-tool' });
  });
  it('keeps smaller-cutoff options separate and clones cache-hit responses', () => {
    insert();
    insert({ model: 'later-model', apiKeyId: 'later-key', apiKeyName: 'Later' });
    queryReport(db, filters());
    const first = queryReport(db, filters({ cutoff: '1' }));
    expect(first.options.models).toEqual([{ provider: 'cx', model: 'model' }]);
    expect(first.options.keys.some((key) => key.id === 'later-key')).toBe(false);
    const hit = queryReport(db, filters({ cutoff: '1' }));
    hit.summary.requests = 999;
    hit.options.keys.length = 0;
    const again = queryReport(db, filters({ cutoff: '1' }));
    expect(again.summary.requests).toBe(1);
    expect(again.options.keys).toHaveLength(1);
  });
  it('uses inclusive calendar end dates with DST spring/fall and non-whole-hour zones', () => {
    const spring = filters();
    expect(spring.startUtc).toBe('2026-03-08T05:00:00.000Z');
    expect(spring.endUtc).toBe('2026-03-09T04:00:00.000Z');
    const fall = filters({ startDate: '2026-11-01', endDate: '2026-11-01' });
    expect(Date.parse(fall.endUtc) - Date.parse(fall.startUtc)).toBe(25 * 3600000);
    const kathmandu = filters({ timezone: 'Asia/Kathmandu' });
    expect(kathmandu.startUtc).toBe('2026-03-07T18:15:00.000Z');
    const range = filters({ endDate: '2026-03-10' });
    const days = dayBoundaries(range);
    expect(days).toHaveLength(3);
    expect(days[0].end).toBe(days[1].start);
    expect(days.at(-1).end).toBe(range.endUtc);
  });
  it('reconciles a midnight DST transition without including the next calendar day hour', () => {
    const f = filters({ startDate: '2018-11-04', endDate: '2018-11-04', timezone: 'America/Sao_Paulo' });
    expect(f.startUtc).toBe('2018-11-04T03:00:00.000Z');
    expect(f.endUtc).toBe('2018-11-05T02:00:00.000Z');
    expect(dayBoundaries(f)[0].end).toBe(f.endUtc);
    insert({ timestamp: '2018-11-05T01:59:59.999Z' });
    insert({ timestamp: '2018-11-05T02:30:00.000Z' });
    const report = queryReport(db, f);
    expect(report.summary.requests).toBe(1);
    expect(report.daily[0].requests).toBe(1);
  });
  it('validates 366 days, real dates, exact identifiers, integers, unknown and duplicate params', () => {
    expect(() => filters({ startDate: '2024-01-01', endDate: '2024-12-31' })).not.toThrow();
    for (const extra of [{ startDate: '2024-01-01', endDate: '2025-01-01' }, { startDate: '2026-02-30' }, { endDate: '2026-03-07' },
      { timezone: 'bad/zone' }, { timezone: '+07:00' }, { page: '0' }, { page: '1.1' }, { pageSize: '101' }, { cutoff: '-1' },
      { cutoff: '9007199254740992' }, { keyId: '' }, { model: 'x'.repeat(257) }, { provider: 'x\n' }, { extra: 'bad' }]) {
      expect(() => filters(extra)).toThrow();
    }
    const params = new URLSearchParams({ startDate: '2026-03-08', endDate: '2026-03-08', timezone: 'UTC' });
    params.append('timezone', 'UTC');
    expect(() => normalizeFilters(params)).toThrow(/duplicate/);
    expect(() => normalizeFilters(new URLSearchParams(), { requireCutoff: true })).toThrow();
  });
  it('reconciles filters, boundaries, summary/group/page/export with stable cutoff including backdated writes', () => {
    insert({ timestamp: '2026-03-08T04:59:59.999Z' });
    insert({ timestamp: '2026-03-08T05:00:00.000Z' });
    insert({ timestamp: '2026-03-09T03:59:59.999Z' });
    insert({ timestamp: '2026-03-09T04:00:00.000Z' });
    insert({ provider: 'mcp-gateway' });
    insert({ apiKeyId: 'other', apiKeyName: 'Other' });
    insert({ connectionId: 'other-account' });
    insert({ model: 'other-model' });
    insert({ provider: 'other-provider' });
    const f = filters({ keyId: 'kenny', provider: 'cx', connectionId: 'account', model: 'model', pageSize: '1' });
    const report = queryReport(db, f);
    expect(report.summary.requests).toBe(2);
    expect(report.summary.totalTokens).toBe(30);
    expect(report.summary.cachedTokens).toBe(16);
    expect(report.summary.cost).toBe(0.5);
    expect(report.pagination).toEqual({ page: 1, pageSize: 1, total: 2, totalPages: 2 });
    expect(report.options.keys.map((k) => k.id)).toContain('other');
    insert({ timestamp: '2026-03-08T10:00:00.000Z' });
    const page2 = queryReport(db, { ...f, page: 2, cutoff: report.cutoff });
    const exported = queryReport(db, { ...f, cutoff: report.cutoff }, { fullExport: true });
    expect(page2.summary).toEqual(report.summary);
    expect(page2.requests[0].id).not.toBe(report.requests[0].id);
    expect(exported.requests).toHaveLength(2);
    for (const group of [report.daily, report.byAccount, report.byModel]) {
      for (const metric of METRICS) expect(group.reduce((sum, r) => sum + r[metric], 0)).toBe(report.summary[metric]);
    }
    expect(queryReport(db, f).summary.requests).toBe(3);
    expect(JSON.stringify(report)).not.toContain('raw-secret');
    expect(JSON.stringify(report)).not.toContain('mcp-gateway');
  });
  it('does not fabricate token evidence from default scalar zero or double-count cache/reasoning subsets', () => {
    insert({ tokens: '{}', promptTokens: 0, completionTokens: 0, cost: null });
    insert({ tokens: '{bad json', promptTokens: 999, completionTokens: 999, cost: null });
    insert({ tokens: JSON.stringify({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cached_tokens: 8, cache_creation_input_tokens: 2, reasoning_tokens: 3 }) });
    insert({ tokens: JSON.stringify({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 }) });
    insert({ tokens: JSON.stringify({ prompt_tokens: '123', completion_tokens: -2, total_tokens: null, reasoning_tokens: true }), cost: null });
    const { summary, requests } = queryReport(db, filters());
    expect(summary).toMatchObject({ requests: 5, inputTokens: 10, outputTokens: 5, totalTokens: 15, cachedTokens: 8,
      cacheCreationTokens: 2, reasoningTokens: 3, cost: 0.5,
      known: { requests: 5, inputTokens: 2, outputTokens: 2, totalTokens: 2, cachedTokens: 2, cacheCreationTokens: 1, reasoningTokens: 1, cost: 2 } });
    expect(requests.filter((r) => r.totalTokens === null)).toHaveLength(3);
  });
  it('returns unknown sums as null, recorded totals without inputs, and partial totals only when both inputs exist', () => {
    insert({ tokens: JSON.stringify({ total_tokens: 22, prompt_tokens_details: { cached_tokens: 4 }, completion_tokens_details: { reasoning_tokens: 2 } }) });
    insert({ tokens: JSON.stringify({ input_tokens: 10 }) });
    const report = queryReport(db, filters());
    expect(report.summary.totalTokens).toBe(22);
    expect(report.summary.known.totalTokens).toBe(1);
    expect(report.summary.outputTokens).toBeNull();
    expect(report.summary.known.outputTokens).toBe(0);
    expect(report.summary.cachedTokens).toBe(4);
    const empty = queryReport(db, filters({ keyId: 'missing' }));
    expect(empty.summary.requests).toBe(0);
    expect(empty.summary.totalTokens).toBeNull();
    expect(empty.pagination.totalPages).toBe(0);
    expect(empty.daily).toHaveLength(1);
  });
  it('never exposes account emails, provider credential data, or raw usage payloads', () => {
    db.run(`INSERT INTO providerConnections(id, provider, authType, email, data, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?, ?)`,
      ['account', 'cx', 'oauth', 'PRIVATE_EMAIL@example.test', '{"accessToken":"PRIVATE_TOKEN"}', '2026', '2026']);
    insert({ meta: '{"prompt":"PRIVATE_PROMPT"}', endpoint: 'PRIVATE_ENDPOINT' });
    const report = queryReport(db, filters());
    expect(report.requests[0].accountName).toBe('account');
    expect(report.options.accounts).toEqual([{ id: 'account', name: 'account' }]);
    expect(JSON.stringify(report)).not.toMatch(/PRIVATE_|raw-secret/);
  });
  it('binds SQL-looking filters literally and supports stable pagination ties', () => {
    insert({ model: "x' OR 1=1 --" });
    insert(); insert();
    expect(queryReport(db, filters({ model: "x' OR 1=1 --" })).summary.requests).toBe(1);
    expect(queryReport(db, filters({ model: '%' })).summary.requests).toBe(0);
    const one = queryReport(db, filters({ pageSize: '1' }));
    const two = queryReport(db, { ...filters({ pageSize: '1', page: '2' }), cutoff: one.cutoff });
    expect(one.requests[0].id).toBeGreaterThan(two.requests[0].id);
  });
});

describe('bounded report cache', () => {
  it('reuses aggregates/options across pages, clones values and preserves unknown evidence', () => {
    insert({ tokens: '{}' }); insert();
    const all = vi.spyOn(db, 'all');
    const first = queryReport(db, filters({ pageSize: '1' }));
    all.mockClear();
    first.summary.totalTokens = 999;
    first.options.keys.length = 0;
    const second = queryReport(db, { ...filters({ pageSize: '1', page: '2' }), cutoff: first.cutoff });
    expect(all).toHaveBeenCalledTimes(1); // only the request page
    expect(second.summary.totalTokens).toBe(15);
    expect(second.summary.known.totalTokens).toBe(1);
    expect(second.requests[0].totalTokens).toBeNull();
    expect(second.options.keys).toHaveLength(1);
    expect(second.requests[0].id).not.toBe(first.requests[0].id);
  });
  it('invalidates after sealing, deletion, and writes above cutoff; clamps future cutoff', () => {
    insert({ apiKeyId: null, apiKeyName: null });
    const f = filters({ cutoff: '999999' });
    const first = queryReport(db, f);
    expect(first.cutoff).toBe(1);
    expect(first.filters.cutoff).toBe(1);
    db.run('INSERT INTO apiKeys(id,key,name,createdAt) VALUES(?,?,?,?)', ['kenny', 'raw-secret', 'Sealed', '2026']);
    sealKeyHistory(db);
    const all = vi.spyOn(db, 'all');
    const next = queryReport(db, { ...f, cutoff: first.cutoff });
    expect(next.requests[0].keyName).toBe('Sealed');
    expect(next.options.keys[0].name).toBe('Sealed');
    expect(all.mock.calls.length).toBeGreaterThan(1);
    insert();
    all.mockClear();
    expect(queryReport(db, { ...f, cutoff: first.cutoff }).summary.requests).toBe(1);
    expect(all.mock.calls.length).toBeGreaterThan(1);
    db.exec('DELETE FROM usageHistory WHERE id = 1');
    expect(queryReport(db, { ...f, cutoff: first.cutoff }).summary.requests).toBe(0);
  });
  it('bounds TTL, entry count, byte size and keeps adapters isolated', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
    try {
      const cache = reportCache(db);
      cache.set('ttl', { value: 1 });
      expect(cache.get('ttl')).toEqual({ value: 1 });
      now.mockReturnValue(1000 + CACHE_LIMITS.ttlMs);
      expect(reportCache(db).get('ttl')).toBeNull();
      const current = reportCache(db);
      for (let i = 0; i <= CACHE_LIMITS.maxEntries; i++) current.set(String(i), { value: i });
      expect(current.get('0')).toBeNull();
      current.set('too-large', { value: 'x'.repeat(CACHE_LIMITS.maxBytes) });
      expect(current.get('too-large')).toBeNull();
      for (let i = 0; i < 8; i++) current.set(`bytes-${i}`, { value: 'x'.repeat(600000) });
      expect(current.get('bytes-0')).toBeNull(); // byte cap before count cap
      expect(current.get('bytes-7')).not.toBeNull();
      const other = { get: db.get };
      expect(reportCache(other).get('1')).toBeNull();
    } finally { now.mockRestore(); }
  });
  it('invalidates on writes by another SQLite connection', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'reports-cache-'));
    const file = path.join(temp, 'db.sqlite');
    const first = new DatabaseSync(file);
    const other = new DatabaseSync(file);
    const adapter = { get: (sql) => first.prepare(sql).get() };
    try {
      first.exec('CREATE TABLE changes(value TEXT)');
      reportCache(adapter).set('cached', { requests: 1 });
      expect(reportCache(adapter).get('cached')).not.toBeNull();
      other.exec("INSERT INTO changes VALUES('external')");
      expect(reportCache(adapter).get('cached')).toBeNull();
    } finally { first.close(); other.close(); fs.rmSync(temp, { recursive: true, force: true }); }
  });
});

describe('pure JS SQLite compatibility', () => {
  it('supports JSON evidence, materialized aggregates and migration on sql.js fallback', async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'reports-sqljs-'));
    const { createSqlJsAdapter } = await import('@/lib/db/adapters/sqljsAdapter.js');
    const adapter = await createSqlJsAdapter(path.join(temp, 'test.sqlite'));
    try {
      for (const [name, table] of Object.entries(TABLES)) adapter.exec(buildCreateTableSql(name, table));
      adapter.run('INSERT INTO usageHistory(timestamp, provider, tokens, cost) VALUES(?, ?, ?, ?)',
        ['2026-03-08T12:00:00.000Z', 'cx', '{"prompt_tokens":10,"completion_tokens":5}', 0.25]);
      migration.up(adapter);
      const report = queryReport(adapter, filters({ endDate: '2026-03-10' }));
      expect(report.summary.totalTokens).toBe(15);
      expect(report.summary.known.totalTokens).toBe(1);
      expect(report.daily.map((row) => row.requests)).toEqual([1, 0, 0]);
    } finally { adapter.close(); fs.rmSync(temp, { recursive: true, force: true }); }
  });
});

describe('durable inference key attribution', () => {
  function key(id, secret, name = id) {
    db.run('INSERT INTO apiKeys(id, key, name, createdAt) VALUES(?, ?, ?, ?)', [id, secret, name, '2026-01-01']);
  }
  it('migration v4 adds columns before auto-sync and backfills only unambiguous exact inference matches', () => {
    expect(SCHEMA_VERSION).toBe(4);
    db.exec('DROP TABLE usageHistory; CREATE TABLE usageHistory(id INTEGER PRIMARY KEY, apiKey TEXT, provider TEXT, timestamp TEXT)');
    key('exact', 'secret', 'Before rename');
    key('collision', 'gateway-secret');
    db.run('INSERT INTO mcpGatewayKeys(id, key, name, createdAt) VALUES(?, ?, ?, ?)', ['g', 'gateway-secret', 'Gateway', '2026']);
    for (const [id, secret, provider] of [[1, 'secret', 'cx'], [2, 'sec***', 'cx'], [3, 'secret', 'mcp-gateway'], [4, 'gateway-secret', 'cx'], [5, 'unknown', null]]) {
      db.run('INSERT INTO usageHistory VALUES(?, ?, ?, ?)', [id, secret, provider, '2026']);
    }
    migration.up(db);
    expect(db.all('SELECT apiKeyId FROM usageHistory ORDER BY id').map((r) => r.apiKeyId)).toEqual(['exact', null, null, null, null]);
    expect(db.get('SELECT apiKeyName FROM usageHistory WHERE id = 1').apiKeyName).toBe('Before rename');
    migration.up(db);
    expect(db.get('SELECT COUNT(*) AS n FROM usageHistory').n).toBe(5);
  });
  it('upgrades an unstamped legacy schema without creating the attribution index before columns', async () => {
    db.exec('DROP INDEX idx_uh_keyid_ts; ALTER TABLE usageHistory DROP COLUMN apiKeyId; ALTER TABLE usageHistory DROP COLUMN apiKeyName');
    const initial = (await import('@/lib/db/migrations/001-initial.js')).default;
    expect(() => initial.up(db)).not.toThrow();
    expect(() => migration.up(db)).not.toThrow();
    expect(db.all('PRAGMA table_info(usageHistory)').map((c) => c.name)).toContain('apiKeyId');
  });
  it('refuses ambiguous keys even in old nonunique schemas and never overwrites populated identity/name', () => {
    db.exec('DROP TABLE apiKeys; CREATE TABLE apiKeys(id TEXT, key TEXT, name TEXT)');
    db.run('INSERT INTO apiKeys VALUES(?, ?, ?)', ['a', 'same', 'A']);
    db.run('INSERT INTO apiKeys VALUES(?, ?, ?)', ['b', 'same', 'B']);
    insert({ apiKey: 'same', apiKeyId: null, apiKeyName: null });
    expect(resolveUsageKey(db, 'same', 'cx')).toBeNull();
    sealKeyHistory(db);
    expect(db.get('SELECT apiKeyId FROM usageHistory').apiKeyId).toBeNull();
    db.exec("DELETE FROM apiKeys WHERE id = 'b'");
    sealKeyHistory(db);
    db.exec("UPDATE apiKeys SET name = 'Renamed'");
    sealKeyHistory(db);
    expect(db.get('SELECT apiKeyName FROM usageHistory').apiKeyName).toBe('A');
  });
  it('captures new writes and seals exact unmatched history before rename/delete without changing raw-key limits', async () => {
    global._dbAdapter = { instance: db };
    try {
      const { updateApiKey, deleteApiKey } = await import('@/lib/db/repos/apiKeysRepo.js');
      const { saveRequestUsage } = await import('@/lib/db/repos/usageRepo.js');
      key('kenny', 'raw-secret', 'Original');
      insert({ apiKeyId: null, apiKeyName: null });
      await updateApiKey('kenny', { name: 'Renamed', rpmLimit: 5 });
      expect(db.get('SELECT apiKeyId, apiKeyName FROM usageHistory')).toMatchObject({ apiKeyId: 'kenny', apiKeyName: 'Original' });
      await saveRequestUsage({ timestamp: '2026-03-08T14:00:00.000Z', provider: 'cx', model: 'new', apiKey: 'raw-secret', tokens: { prompt_tokens: 2, completion_tokens: 1 } });
      expect(db.get("SELECT apiKeyId, apiKeyName, apiKey FROM usageHistory WHERE model = 'new'")).toMatchObject({ apiKeyId: 'kenny', apiKeyName: 'Renamed', apiKey: 'raw-secret' });
      insert({ apiKeyId: null, apiKeyName: null, timestamp: '2026-03-08T15:00:00.000Z' });
      expect(await deleteApiKey('kenny')).toBe(true);
      expect(await deleteApiKey('kenny')).toBe(false);
      const report = queryReport(db, filters({ keyId: 'kenny' }));
      expect(report.summary.requests).toBe(3);
      expect(report.options.keys).toEqual([{ id: 'kenny', name: 'Renamed' }]);
      expect(db.get('SELECT COUNT(*) AS n FROM usageHistory WHERE apiKey = ?', ['raw-secret']).n).toBe(3);
    } finally { delete global._dbAdapter; vi.resetModules(); }
  });
  it('attributes real first-boot JSON imports and repairs rollback-written rows on the next boot', async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'reports-import-'));
    const prior = process.env.DATA_DIR;
    process.env.DATA_DIR = temp;
    delete global._dbAdapter;
    vi.resetModules();
    fs.writeFileSync(path.join(temp, 'db.json'), JSON.stringify({ apiKeys: [{ id: 'imported', key: 'exact-secret', name: 'Imported name', createdAt: '2026-01-01' }] }));
    fs.writeFileSync(path.join(temp, 'usage.json'), JSON.stringify({ history: [
      { apiKey: 'exact-secret', provider: 'cx' }, { apiKey: 'exact***', provider: 'cx' },
      { apiKey: 'exact-secret', provider: 'mcp-gateway' }, { apiKey: 'unknown-secret', provider: 'cx' },
    ] }));
    try {
      let adapter = await (await import('@/lib/db/driver.js')).getAdapter();
      expect(adapter.all('SELECT apiKeyId FROM usageHistory ORDER BY id').map((r) => r.apiKeyId)).toEqual(['imported', null, null, null]);
      expect(adapter.get('SELECT apiKeyName FROM usageHistory WHERE id = 1').apiKeyName).toBe('Imported name');
      adapter.run('INSERT INTO usageHistory(timestamp,provider,apiKey) VALUES(?,?,?)', ['2026', 'cx', 'exact-secret']);
      adapter.exec("UPDATE apiKeys SET name = 'New name'");
      adapter.close();
      delete global._dbAdapter; vi.resetModules();
      adapter = await (await import('@/lib/db/driver.js')).getAdapter();
      expect(adapter.get('SELECT apiKeyName FROM usageHistory WHERE id = 5').apiKeyName).toBe('New name');
      expect(adapter.get('SELECT apiKeyName FROM usageHistory WHERE id = 1').apiKeyName).toBe('Imported name');
      expect(adapter.get('SELECT COUNT(*) AS n FROM usageHistory').n).toBe(5);
      expect(fs.existsSync(path.join(temp, 'db.json'))).toBe(true);
      adapter.close();
    } finally {
      delete global._dbAdapter;
      if (prior === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = prior;
      vi.resetModules(); fs.rmSync(temp, { recursive: true, force: true });
    }
  });
  it('backs up version 3 before versioned attribution migration and stamps backup schema 4', async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'reports-migration-'));
    const prior = process.env.DATA_DIR;
    process.env.DATA_DIR = temp;
    delete global._dbAdapter;
    vi.resetModules();
    try {
      const { getAdapter } = await import('@/lib/db/driver.js');
      let adapter = await getAdapter();
      adapter.exec("UPDATE _meta SET value = '3' WHERE key IN ('schemaVersion', 'backupSchemaVersion'); DROP INDEX idx_uh_keyid_ts; ALTER TABLE usageHistory DROP COLUMN apiKeyId; ALTER TABLE usageHistory DROP COLUMN apiKeyName;");
      adapter.close();
      delete global._dbAdapter;
      vi.resetModules();
      adapter = await (await import('@/lib/db/driver.js')).getAdapter();
      expect(adapter.get("SELECT value FROM _meta WHERE key = 'schemaVersion'").value).toBe('4');
      expect(adapter.get("SELECT value FROM _meta WHERE key = 'backupSchemaVersion'").value).toBe('4');
      const files = fs.readdirSync(temp, { recursive: true });
      expect(files.some((name) => String(name).includes('schema-3-to-4'))).toBe(true);
      adapter.close();
    } finally {
      delete global._dbAdapter;
      if (prior === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = prior;
      vi.resetModules();
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });
});
