// Real gateway adapter, held WAL reader + concurrent writes. No production data.
// Run with node or bun; use better-sqlite3 only with a compatible safe runtime.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { openReportDatabase } from '../src/lib/usage-reports/worker-db.js';

const driver = process.argv[2] || (process.versions.bun ? 'bun:sqlite' : 'node:sqlite');
const names = { 'node:sqlite': ['nodeSqlite', 'createNodeSqliteAdapter'], 'bun:sqlite': ['bunSqlite', 'createBunSqliteAdapter'], 'better-sqlite3': ['betterSqlite', 'createBetterSqliteAdapter'] };
const [name, factory] = names[driver];
const createAdapter = (await import(`../src/lib/db/adapters/${name}Adapter.js`))[factory];
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'report-checkpoint-'));
const file = path.join(dir, 'db.sqlite');
let timerCallback, db, reader;
const originalInterval = globalThis.setInterval;
try {
  // Capture the actual 60s timer callback. No adapter logic is mocked: invoke
  // exactly what the natural timer would run while a WAL read snapshot is held.
  globalThis.setInterval = (callback, ms, ...args) => {
    if (ms === 60000) timerCallback = callback;
    return originalInterval(callback, ms, ...args);
  };
  try { db = await createAdapter(file); } finally { globalThis.setInterval = originalInterval; }
  assert.equal(typeof timerCallback, 'function');
  db.exec('CREATE TABLE probe(id INTEGER PRIMARY KEY, value TEXT); INSERT INTO probe(value) VALUES (\'before\')');
  reader = await openReportDatabase(driver, file);
  reader.all('BEGIN');
  assert.equal(reader.get('SELECT COUNT(*) AS n FROM probe').n, 1);
  db.run('INSERT INTO probe(value) VALUES (?)', ['committed during reader']);
  assert.equal(db.get('PRAGMA busy_timeout').timeout, 5000);
  const durations = [];
  for (const checkpoint of [() => db.checkpoint(), timerCallback]) {
    const start = performance.now(); checkpoint(); durations.push(performance.now() - start);
  }
  assert.ok(durations.every((ms) => ms < 50), `Blocking checkpoint ${durations}`);
  assert.equal(reader.get('SELECT COUNT(*) AS n FROM probe').n, 1);
  reader.all('COMMIT'); reader.close(); reader = null;
  db.checkpoint();
  const final = db.get('PRAGMA wal_checkpoint(PASSIVE)');
  assert.equal(final.busy, 0);
  assert.equal(final.log, final.checkpointed);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM probe').n, 2);
  assert.throws(() => db.transaction(() => { db.run('INSERT INTO probe(value) VALUES (?)', ['rollback']); throw new Error('rollback'); }));
  assert.equal(db.get('SELECT COUNT(*) AS n FROM probe').n, 2);
  // WAL can retain its allocation after PASSIVE; shutdown still truncates.
  const walBeforeClose = fs.statSync(file + '-wal').size;
  db.close(); db = null;
  assert.ok(!fs.existsSync(file + '-wal') || fs.statSync(file + '-wal').size === 0);
  console.log(JSON.stringify({ driver, explicitCheckpointMs: durations[0], actualTimerCallbackMs: durations[1], busyTimeoutUnchanged: 5000, committedRows: 2, rollbackPreserved: true, walBeforeClose, shutdownTruncates: true, passed: true }));
} finally {
  globalThis.setInterval = originalInterval;
  if (reader) reader.close();
  if (db) db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
