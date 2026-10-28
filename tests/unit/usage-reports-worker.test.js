import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ReportExecutor } from '@/lib/usage-reports/executor.js';
import { openReportDatabase } from '@/lib/usage-reports/worker-db.js';
import { normalizeFilters } from '@/lib/usage-reports/filters.js';
import { TABLES, buildCreateTableSql } from '@/lib/db/schema.js';
import { reportWorkerAssets } from '../../scripts/usage-report-worker-assets.mjs';
import { encodeReport, MAX_OUTPUT_BYTES } from '@/lib/usage-reports/worker-output.js';
import { METRICS } from '@/lib/usage-reports/query.js';

const filters = normalizeFilters(new URLSearchParams({ startDate: '2026-01-01', endDate: '2026-01-01', timezone: 'UTC' }));
const data = { driver: 'node:sqlite', filePath: '/synthetic.sqlite', filters };
const workerPath = path.resolve(import.meta.dirname, '../../src/lib/usage-reports/worker.mjs');
function controlled(options = {}) {
  const workers = [];
  const makeWorker = vi.fn(() => {
    const worker = new EventEmitter();
    worker.terminate = vi.fn(() => Promise.resolve(1));
    workers.push(worker);
    return worker;
  });
  return { workers, makeWorker, executor: new ReportExecutor({ makeWorker, ...options }) };
}
function finish(worker) { worker.emit('message', { bytes: new Uint8Array([1]).buffer }); worker.emit('exit', 0); }

describe('worker encoded output budget', () => {
  it('rejects oversized JSON and XLSX explicitly without truncation', async () => {
    expect(MAX_OUTPUT_BYTES).toBe(64 * 1024 * 1024);
    const summary = { ...Object.fromEntries(METRICS.map((m) => [m, 0])), known: Object.fromEntries(METRICS.map((m) => [m, 0])) };
    const report = { filters, cutoff: 0, summary, daily: [], byModel: [], byAccount: [], byKey: [], requests: [] };
    for (const fullExport of [false, true]) {
      const bytes = await encodeReport(report, fullExport);
      expect(bytes.length).toBeGreaterThan(100);
      await expect(encodeReport(report, fullExport, 100)).rejects.toMatchObject({ status: 413, message: expect.stringContaining('narrow the filters') });
      if (!fullExport) expect(JSON.parse(new TextDecoder().decode(bytes))).toEqual(report);
      else expect([...bytes.slice(0, 2)]).toEqual([80, 75]);
    }
  });
});

describe('report worker packaging contract', () => {
  it('traces source, module boundary, XLSX dependency closure and Docker smoke', () => {
    const root = path.resolve(import.meta.dirname, '../..');
    const assets = reportWorkerAssets(root);
    for (const dependency of ['exceljs', 'luxon', 'archiver', 'readable-stream']) {
      expect(assets).toContain(`./node_modules/${dependency}/**/*`);
    }
    expect(assets).toContain('./src/lib/usage-reports/**/*');
    expect(assets.every((entry) => entry.startsWith('./') && !entry.includes('../'))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(root, 'src/lib/usage-reports/package.json'))).type).toBe('module');
    const config = fs.readFileSync(path.join(root, 'next.config.mjs'), 'utf8');
    expect(config).toContain("'/api/usage/reports': reportWorkerAssets(projectRoot)");
    expect(config).toContain("'/api/usage/reports/export': reportWorkerAssets(projectRoot)");
    const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
    expect(dockerfile).toContain('cp -a /app/.next/standalone /tmp/report-worker-standalone');
    expect(dockerfile).toContain('node scripts/check-report-worker.mjs /tmp/report-worker-standalone node:sqlite');
    expect(dockerfile).toContain('node scripts/check-report-worker.mjs /tmp/report-worker-standalone better-sqlite3');
    expect(dockerfile).toContain('COPY --from=builder /app/.next/standalone ./');
  });
});

describe('isolated report scheduler', () => {
  it('rejects sql.js without starting a worker or touching the database', async () => {
    const { executor, makeWorker } = controlled();
    await expect(executor.execute({ ...data, driver: 'sql.js' })).rejects.toMatchObject({ status: 503, message: expect.stringContaining('native SQLite') });
    expect(makeWorker).not.toHaveBeenCalled();
  });
  it('runs one job, queues two, rejects overload, and waits for exit before replacement', async () => {
    const { executor, workers, makeWorker } = controlled();
    const jobs = [executor.execute(data), executor.execute(data), executor.execute(data)];
    await expect(executor.execute(data)).rejects.toMatchObject({ status: 503 });
    expect(makeWorker).toHaveBeenCalledTimes(1);
    workers[0].emit('message', { bytes: new Uint8Array([1]).buffer });
    expect(makeWorker).toHaveBeenCalledTimes(1);
    expect(workers[0].terminate).toHaveBeenCalledOnce();
    workers[0].emit('exit', 0);
    expect(makeWorker).toHaveBeenCalledTimes(2);
    finish(workers[1]); finish(workers[2]);
    await Promise.all(jobs);
    expect(executor.active).toBeNull();
    expect(executor.queue).toHaveLength(0);
    expect(makeWorker.mock.calls[0][1]).toMatchObject({ env: {}, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 256 } });
  });
  it('aborts queued and active work; no replacement until the terminated worker exits', async () => {
    const { executor, workers, makeWorker } = controlled();
    const active = new AbortController(), queued = new AbortController();
    const first = executor.execute(data, { signal: active.signal });
    const second = executor.execute(data, { signal: queued.signal });
    const firstRejected = expect(first).rejects.toMatchObject({ status: 499 });
    const secondRejected = expect(second).rejects.toMatchObject({ status: 499 });
    queued.abort(); active.abort();
    await Promise.all([firstRejected, secondRejected]);
    const third = executor.execute(data);
    expect(makeWorker).toHaveBeenCalledTimes(1);
    workers[0].emit('exit', 1);
    finish(workers[1]); await third;
    expect(executor.active).toBeNull();
    await expect(executor.execute(data, { signal: active.signal })).rejects.toMatchObject({ status: 499 });
  });
  it('counts queue time toward deadline and retains active slot after termination request', async () => {
    vi.useFakeTimers();
    try {
      const { executor, workers, makeWorker } = controlled({ timeoutMs: 50 });
      const first = executor.execute(data), second = executor.execute(data);
      const rejected = [expect(first).rejects.toMatchObject({ status: 504 }), expect(second).rejects.toMatchObject({ status: 504 })];
      await vi.advanceTimersByTimeAsync(51);
      await Promise.all(rejected);
      expect(workers[0].terminate).toHaveBeenCalledOnce();
      expect(makeWorker).toHaveBeenCalledTimes(1);
      expect(executor.queue).toHaveLength(0);
      workers[0].emit('exit', 1);
      expect(executor.active).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it('does not trust an unexpected worker error status or its secret message', async () => {
    const { executor, workers } = controlled();
    const result = executor.execute(data);
    const rejected = expect(result).rejects.toMatchObject({ status: 500, message: 'Unable to generate usage report' });
    workers[0].emit('message', { error: { status: 418, message: 'SECRET' } });
    workers[0].emit('exit', 0);
    await rejected;
    expect(executor.active).toBeNull();
  });
  it('fails closed if termination throws and does not launch overlapping workers', async () => {
    const { executor, workers, makeWorker } = controlled();
    const abort = new AbortController();
    const first = executor.execute(data, { signal: abort.signal });
    const rejected = expect(first).rejects.toMatchObject({ status: 499 });
    workers[0].terminate.mockImplementation(() => { throw new Error('runtime failure'); });
    expect(() => abort.abort()).not.toThrow();
    await rejected;
    const next = executor.execute(data);
    expect(makeWorker).toHaveBeenCalledTimes(1);
    workers[0].emit('exit', 1);
    finish(workers[1]); await next;
  });
  it('cleans up spawn errors, worker errors, unexpected exits and shutdown', async () => {
    const failing = new ReportExecutor({ makeWorker() { throw new Error('SECRET'); } });
    await expect(failing.execute(data)).rejects.toMatchObject({ status: 503 });
    expect(failing.active).toBeNull();
    const { executor, workers } = controlled();
    const first = executor.execute(data);
    const rejected = expect(first).rejects.toMatchObject({ status: 500, message: 'Isolated usage reporting failed' });
    workers[0].emit('error', new Error('SECRET')); workers[0].emit('exit', 1); await rejected;
    const second = executor.execute(data);
    const stopped = expect(second).rejects.toMatchObject({ status: 500 });
    workers[1].emit('exit', 0); await stopped;
    const third = executor.execute(data), fourth = executor.execute(data);
    const shutting = [expect(third).rejects.toMatchObject({ status: 503 }), expect(fourth).rejects.toMatchObject({ status: 503 })];
    const closed = executor.close();
    workers[2].emit('exit', 1); await closed; await Promise.all(shutting);
    await expect(executor.execute(data)).rejects.toMatchObject({ status: 503 });
  });
});

describe('real native read-only reporting workers', () => {
  it('keeps explicit and actual timer checkpoints non-blocking with a pinned reader and live write', () => {
    const root = path.resolve(import.meta.dirname, '../..');
    const output = execFileSync(process.execPath, ['scripts/check-report-worker-checkpoints.mjs', 'node:sqlite'], { cwd: root, encoding: 'utf8', timeout: 15000 });
    expect(JSON.parse(output.trim())).toMatchObject({ passed: true, busyTimeoutUnchanged: 5000, rollbackPreserved: true, shutdownTruncates: true });
  });
  it('sanitizes a real worker unexpected database error instead of exposing table/path details', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'SECRET-report-db-'));
    const filePath = path.join(dir, 'SECRET.sqlite');
    const raw = new DatabaseSync(filePath); raw.exec('CREATE TABLE SECRET_TABLE(id)'); raw.close();
    const executor = new ReportExecutor({ workerPath });
    try {
      await expect(executor.execute({ ...data, filePath })).rejects.toMatchObject({ status: 500, message: 'Unable to generate usage report' });
      expect(executor.active).toBeNull();
    } finally { await executor.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it('terminates a real busy worker on abort/timeout and runs a queued replacement only after exit', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'report-lifecycle-'));
    const fixture = path.join(dir, 'worker.mjs');
    fs.writeFileSync(fixture, `import { parentPort, workerData } from 'node:worker_threads';
      if (workerData.fullExport) { while (true) {} }
      else { const bytes = new Uint8Array([1]); parentPort.postMessage({bytes:bytes.buffer}, [bytes.buffer]); parentPort.close(); }`);
    const executor = new ReportExecutor({ workerPath: fixture, timeoutMs: 1000 });
    try {
      const controller = new AbortController();
      const active = executor.execute({ ...data, fullExport: true }, { signal: controller.signal });
      const rejected = expect(active).rejects.toMatchObject({ status: 499 });
      const replacement = executor.execute(data);
      controller.abort(); await rejected;
      expect(await replacement).toEqual(new Uint8Array([1]));
      expect(executor.active).toBeNull();
      await expect(executor.execute({ ...data, fullExport: true })).rejects.toMatchObject({ status: 504 });
      await executor.close();
      expect(executor.active).toBeNull();
    } finally { await executor.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it('rejects writes, sees new WAL commits, keeps cutoff, excludes secrets, and exports real XLSX', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'report-worker-'));
    const filePath = path.join(dir, 'db.sqlite');
    const raw = new DatabaseSync(filePath);
    const executor = new ReportExecutor({ workerPath });
    try {
      raw.exec('PRAGMA journal_mode=WAL');
      for (const [name, table] of Object.entries(TABLES)) raw.exec(buildCreateTableSql(name, table));
      const insert = raw.prepare(`INSERT INTO usageHistory(timestamp, provider, model, apiKey, tokens) VALUES('2026-01-01T01:00:00.000Z', 'cx', 'test', 'SECRET', '{"total_tokens":7}')`);
      insert.run();
      const db = await openReportDatabase('node:sqlite', filePath);
      expect(() => db.all('DELETE FROM usageHistory RETURNING id')).toThrow();
      expect(db.get('PRAGMA query_only').query_only).toBe(1);
      db.close();
      const call = (f = filters, fullExport = false) => executor.execute({ driver: 'node:sqlite', filePath, filters: f, fullExport });
      const first = JSON.parse(new TextDecoder().decode(await call()));
      expect(first.summary.requests).toBe(1);
      insert.run();
      expect(JSON.parse(new TextDecoder().decode(await call())).summary.requests).toBe(2);
      const frozen = JSON.parse(new TextDecoder().decode(await call({ ...filters, cutoff: first.cutoff })));
      expect(frozen.summary.requests).toBe(1);
      expect(JSON.stringify(frozen)).not.toContain('SECRET');
      const bytes = await call({ ...filters, cutoff: first.cutoff }, true);
      expect([...bytes.slice(0, 2)]).toEqual([80, 75]);
      expect(executor.active).toBeNull();
      await expect(executor.execute({ ...data, filePath: path.join(dir, 'missing') })).rejects.toMatchObject({ status: 500 });
      expect(fs.existsSync(path.join(dir, 'missing'))).toBe(false);
    } finally { await executor.close(); raw.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
