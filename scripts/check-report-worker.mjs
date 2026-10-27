// Run against a relocated standalone directory, with NO dependency symlinks.
// Synthetic DB only; proves worker source, module boundary and XLSX dependencies.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(process.argv[2] || '.next/standalone');
const driver = process.argv[3] || (process.versions.bun ? 'bun:sqlite' : 'node:sqlite');
const requirePackaged = createRequire(path.join(root, 'package.json'));
const Database = driver === 'bun:sqlite' ? (await import('bun:sqlite')).Database
  : driver === 'better-sqlite3' ? requirePackaged('better-sqlite3')
    : (await import('node:sqlite')).DatabaseSync;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'report-worker-smoke-'));
const filePath = path.join(temp, 'synthetic.sqlite');
const raw = new Database(filePath);
raw.exec(`CREATE TABLE usageHistory(id INTEGER PRIMARY KEY, timestamp TEXT, provider TEXT, model TEXT, connectionId TEXT, apiKeyId TEXT, apiKeyName TEXT, tokens TEXT, cost REAL);
  CREATE TABLE providerConnections(id TEXT, name TEXT);
  CREATE TABLE apiKeys(id TEXT, name TEXT);
  INSERT INTO usageHistory VALUES(1, '2026-01-01T01:00:00.000Z', 'synthetic', 'model', NULL, NULL, NULL, '{"total_tokens":7}', 0);`);
raw.close();
const filters = { startDate: '2026-01-01', endDate: '2026-01-01', timezone: 'UTC', startUtc: '2026-01-01T00:00:00.000Z', endUtc: '2026-01-02T00:00:00.000Z', page: 1, pageSize: 25, cutoff: 1 };
try {
  const { openReportDatabase } = await import(pathToFileURL(path.join(root, 'src/lib/usage-reports/worker-db.js')));
  const readOnly = await openReportDatabase(driver, filePath);
  let writeRejected = false;
  try { readOnly.all('DELETE FROM usageHistory RETURNING id'); } catch { writeRejected = true; }
  readOnly.close();
  if (!writeRejected) throw new Error('Read-only connection allowed mutation');
  const { ReportExecutor } = await import(pathToFileURL(path.join(root, 'src/lib/usage-reports/executor.js')));
  const executor = new ReportExecutor({ workerPath: path.join(root, 'src/lib/usage-reports/worker.mjs') });
  try {
    const jobs = [false, true, false].map((fullExport) => executor.execute({ driver, filePath, filters, fullExport }));
    await Promise.all(jobs);
    if (executor.active || executor.queue.length) throw new Error('Scheduler failed to clean up workers');
  } finally { await executor.close(); }
  const fixture = path.join(temp, 'busy.mjs');
  fs.writeFileSync(fixture, `import { parentPort, workerData } from 'node:worker_threads';
    if (workerData.fullExport) { while (true) {} }
    else { const b=new Uint8Array([1]); parentPort.postMessage({bytes:b.buffer},[b.buffer]); parentPort.close(); }`);
  // Leave startup headroom on loaded CI/Bun hosts. This is a reduced test
  // deadline; production grants 60 seconds including the queue.
  const lifecycle = new ReportExecutor({ workerPath: fixture, timeoutMs: 3000 });
  try {
    const abort = new AbortController();
    const cancelled = lifecycle.execute({ driver, filePath, filters, fullExport: true }, { signal: abort.signal }).catch((error) => error.status);
    const queued = lifecycle.execute({ driver, filePath, filters });
    abort.abort();
    if (await cancelled !== 499 || (await queued)[0] !== 1) throw new Error('Runtime abort/replacement failed');
    const timeout = await lifecycle.execute({ driver, filePath, filters, fullExport: true }).catch((error) => error.status);
    if (timeout !== 504) throw new Error('Runtime timeout failed');
  } finally { await lifecycle.close(); }
  if (lifecycle.active || lifecycle.queue.length) throw new Error('Runtime lifecycle cleanup failed');
  console.log(JSON.stringify({ driver, scheduler: '3 serial jobs, abort+replacement, busy-worker timeout+exit', passed: true }));
  for (const fullExport of [false, true]) {
    const result = await new Promise((resolve, reject) => {
      const worker = new Worker(path.join(root, 'src/lib/usage-reports/worker.mjs'), {
        workerData: { driver, filePath, filters, fullExport }, env: {}, execArgv: [],
      });
      let response;
      const timer = setTimeout(() => { worker.terminate(); reject(new Error('Worker smoke timed out')); }, 30000);
      worker.once('message', (message) => { response = message; });
      worker.once('error', reject);
      worker.once('exit', (code) => {
        clearTimeout(timer);
        if (code || !response?.bytes) reject(new Error(`Packaged worker failed: ${JSON.stringify(response)}`));
        else resolve(new Uint8Array(response.bytes));
      });
    });
    if (fullExport ? result[0] !== 80 || result[1] !== 75 : JSON.parse(new TextDecoder().decode(result)).summary.totalTokens !== 7) {
      throw new Error('Packaged worker output mismatch');
    }
    console.log(JSON.stringify({ standaloneRoot: root, driver, fullExport, bytes: result.length, writeRejected, passed: true }));
  }
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
