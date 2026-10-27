// Synthetic-only file DB; never opens configured application data.
// node scripts/benchmark-usage-reports.mjs [rows=300000]
// Exercise the actual gateway adapter and its checkpoint/busy-timeout policy.
const driver = process.versions.bun ? 'bun:sqlite' : 'node:sqlite';
const createAdapter = process.versions.bun
  ? (await import('../src/lib/db/adapters/bunSqliteAdapter.js')).createBunSqliteAdapter
  : (await import('../src/lib/db/adapters/nodeSqliteAdapter.js')).createNodeSqliteAdapter;
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { TABLES, buildCreateTableSql } from '../src/lib/db/schema.js';
import { normalizeFilters } from '../src/lib/usage-reports/filters.js';
import { ReportExecutor } from '../src/lib/usage-reports/executor.js';
import { reportWhere } from '../src/lib/usage-reports/query.js';

const rows = Number(process.argv[2] || 300000);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'report-benchmark-'));
const filePath = path.join(dir, 'synthetic.sqlite');
const gateway = await createAdapter(filePath);
const raw = gateway.raw;
const executor = new ReportExecutor();
const server = http.createServer((req, res) => { res.end('lightweight-ok'); });
const tokens = JSON.stringify({ prompt_tokens: 100, completion_tokens: 40, total_tokens: 140, cached_tokens: 30, cache_creation_input_tokens: 5, reasoning_tokens: 10 });
function filters(overrides = {}) {
  return normalizeFilters(new URLSearchParams({ startDate: '2026-01-01', endDate: '2026-03-01', timezone: 'UTC', ...overrides }));
}
let insert;
try {
  raw.exec('PRAGMA journal_mode=WAL');
  for (const [name, table] of Object.entries(TABLES)) {
    raw.exec(buildCreateTableSql(name, table));
    for (const index of table.indexes || []) raw.exec(index);
  }
  insert = raw.prepare(`INSERT INTO usageHistory(timestamp, provider, model, connectionId, apiKeyId, apiKeyName, tokens, cost) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`);
  const seedStart = performance.now();
  raw.exec('BEGIN');
  for (let i = 0; i < rows; i++) {
    insert.run(new Date(Date.UTC(2026, 0, 1) + Math.floor(i / 5000) * 86400000 + (i % 5000) * 1000).toISOString(),
      'synthetic-provider', `model-${i % 5}`, `account-${i % 10}`, `key-${i % 20}`, `Synthetic ${i % 20}`, tokens, 0.001);
  }
  raw.exec('COMMIT');
  console.log(JSON.stringify({ syntheticRows: rows, seedMs: Math.round(performance.now() - seedStart), runtime: process.version, driver }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  async function benchmark(name, f, fullExport = false) {
    const lag = monitorEventLoopDelay({ resolution: 10 });
    lag.enable();
    let peakRss = process.memoryUsage().rss;
    let lastTick = performance.now(), maxTimerGapMs = 0, checkpoints = 0;
    const maintenance = setInterval(() => {
      gateway.run('INSERT INTO _meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', ['benchmark-live-write', String(checkpoints++)]);
      gateway.checkpoint();
    }, 50);
    const latencies = [];
    let inflight = false;
    const timer = setInterval(() => {
      const now = performance.now();
      maxTimerGapMs = Math.max(maxTimerGapMs, now - lastTick); lastTick = now;
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
      if (inflight) return;
      inflight = true;
      const start = performance.now();
      http.get(url, (res) => {
        res.resume();
        res.on('end', () => { latencies.push(performance.now() - start); inflight = false; });
      }).on('error', () => { inflight = false; });
    }, 10);
    const start = performance.now();
    let bytes;
    try { bytes = await executor.execute({ driver, filePath, filters: f, fullExport }); }
    finally { clearInterval(timer); clearInterval(maintenance); lag.disable(); }
    const elapsedMs = performance.now() - start;
    // Parsing for benchmark assertions happens after timing; HTTP routes return
    // transferred bytes directly and never parse/serialize them on main.
    const report = fullExport ? null : JSON.parse(new TextDecoder().decode(bytes));
    if (report && report.summary.totalTokens !== report.summary.requests * 140) throw new Error('Token reconciliation failed');
    if (fullExport && (bytes[0] !== 80 || bytes[1] !== 75)) throw new Error('Not XLSX');
    const maxRequestMs = Math.max(0, ...latencies);
    const lagMs = lag.max / 1e6;
    console.log(JSON.stringify({ name, elapsedMs: Math.round(elapsedMs), returnedRows: report?.requests.length,
      requests: report?.summary.requests, bytes: bytes.length, lightweightResponses: latencies.length,
      maxLightweightRequestMs: Math.round(maxRequestMs), maxEventLoopDelayMs: Math.round(lagMs), maxTimerGapMs: Math.round(maxTimerGapMs), concurrentWriteCheckpoints: checkpoints, peakProcessRssMiB: Math.round(peakRss / 1048576) }));
    // Broad shared-host safety threshold, not an inference latency SLA.
    if (!latencies.length || !checkpoints || maxRequestMs >= 50 || lagMs >= 50 || maxTimerGapMs >= 50) throw new Error('Gateway responsiveness budget exceeded');
    return report;
  }
  const first = await benchmark('300k-unfiltered-cold', filters());
  insert.run('2026-01-01T00:00:00.000Z', 'synthetic-provider', 'model-0', 'account-0', 'key-0', 'Synthetic 0', tokens, 0.001);
  const next = await benchmark('300k-page-after-live-write', filters({ cutoff: String(first.cutoff), page: '2' }));
  if (next.summary.requests !== first.summary.requests) throw new Error('Cutoff regression');
  await benchmark('300k-selected-key', filters({ keyId: 'key-3' }));
  await benchmark('maximum-366-calendar-days', filters({ startDate: '2025-03-01', endDate: '2026-03-01' }));
  await benchmark('50000-row-query-and-xlsx', filters({ endDate: '2026-01-10', cutoff: String(first.cutoff) }), true);
  try {
    await executor.execute({ driver, filePath, filters: filters({ cutoff: String(first.cutoff) }), fullExport: true });
    throw new Error('Expected export cap');
  } catch (error) { if (error.status !== 413) throw error; console.log(JSON.stringify({ overCapExportStatus: error.status })); }
  const where = reportWhere(filters({ keyId: 'key-3' }), first.cutoff);
  console.log(JSON.stringify({ queryPlan: raw.prepare(`EXPLAIN QUERY PLAN SELECT h.id FROM usageHistory h WHERE ${where.sql} ORDER BY timestamp DESC, id DESC LIMIT 25`).all(...where.params),
    limits: '1 active worker, 2 queued, 60s total deadline; V8 old heap256MiB (NOT RSS cap), SQLite cache16MiB + disk temp, response64MiB after encoding; no global/multiprocess budget' }));
} finally {
  await executor.close();
  await new Promise((resolve) => server.close(resolve));
  gateway.close(); fs.rmSync(dir, { recursive: true, force: true });
}
