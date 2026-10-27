// Relocate the actual Next build, exercise its HTTP routes, then remove it.
// No installed dependencies are copied from the source node_modules directory.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { SignJWT } from 'jose';
import { DatabaseSync } from 'node:sqlite';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'relocated-report-worker-'));
const root = path.join(temp, 'app');
const dataDir = path.join(temp, 'data');
let server;
try {
  const source = path.resolve(process.argv[2] || '.next/standalone');
  // A build made against a symlinked node_modules can carry that symlink into
  // standalone. Dereferencing it would falsely prove packaging using ALL deps.
  function checkLinks(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const relative = path.relative(source, fs.realpathSync(file));
        if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Standalone contains external symlink: ${file}`);
      } else if (entry.isDirectory()) checkLinks(file);
    }
  }
  checkLinks(source);
  fs.cpSync(source, root, { recursive: true, dereference: true });
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const secret = 'synthetic-standalone-report-smoke-only';
  server = spawn(process.execPath, ['server.js'], { cwd: root,
    env: { PATH: process.env.PATH, NODE_ENV: 'production', PORT: String(port), HOSTNAME: '127.0.0.1', DATA_DIR: dataDir, JWT_SECRET: secret, NEXT_TELEMETRY_DISABLED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Standalone readiness timeout')), 30000);
    server.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Standalone exited ${code}`)); });
    const output = (chunk) => {
      const text = String(chunk);
      // Logs contain synthetic paths only; never use this script with real data.
      process.stdout.write(text);
      if (text.includes('Ready in')) { clearTimeout(timer); resolve(); }
    };
    server.stdout.on('data', output); server.stderr.on('data', output);
  });
  const url = `http://127.0.0.1:${port}/api/usage/reports`;
  const params = '?startDate=2026-01-01&endDate=2026-01-01&timezone=UTC';
  const noAuth = await fetch(url + params);
  if (noAuth.status !== 401) throw new Error(`Unauthenticated status ${noAuth.status}`);
  const token = await new SignJWT({ authenticated: true }).setProtectedHeader({ alg: 'HS256' }).setExpirationTime('5m').sign(new TextEncoder().encode(secret));
  const headers = { cookie: `auth_token=${token}` };
  const first = await fetch(url + params, { headers });
  if (first.status !== 200) throw new Error(`First report ${first.status}: ${await first.text()}`);
  await first.json();
  const db = new DatabaseSync(path.join(dataDir, 'db/data.sqlite'));
  db.prepare(`INSERT INTO usageHistory(timestamp,provider,model,tokens,apiKey) VALUES(?,?,?,?,?)`).run('2026-01-01T01:00:00.000Z', 'synthetic', 'test', '{"total_tokens":7}', 'NEVER_RETURN_THIS_SECRET');
  db.close();
  const json = await fetch(url + params, { headers });
  const report = await json.json();
  if (json.status !== 200 || report.summary.totalTokens !== 7 || JSON.stringify(report).includes('NEVER_RETURN_THIS_SECRET')) throw new Error('Relocated JSON reconciliation/secrecy failed');
  const xlsx = await fetch(url + '/export' + params + `&cutoff=${report.cutoff}`, { headers });
  const bytes = new Uint8Array(await xlsx.arrayBuffer());
  if (xlsx.status !== 200 || bytes[0] !== 80 || bytes[1] !== 75 || xlsx.headers.get('cache-control') !== 'no-store') throw new Error('Relocated XLSX failed');
  console.log(JSON.stringify({ relocated: true, root, unauthorized: noAuth.status, json: json.status, xlsx: xlsx.status, totalTokens: report.summary.totalTokens, xlsxBytes: bytes.length, passed: true }));
} finally {
  if (server && server.exitCode === null) {
    const exited = once(server, 'exit');
    server.kill('SIGTERM');
    const timer = setTimeout(() => server.kill('SIGKILL'), 3000);
    await exited; clearTimeout(timer);
  }
  fs.rmSync(temp, { recursive: true, force: true });
}
