import fs from 'node:fs';
const [claude, codex] = process.argv.slice(2);
const version = /^\d+\.\d+\.\d+(?:[.-][0-9A-Za-z.-]+)?$/;
for (const value of [claude, codex]) {
  if (value && !version.test(value)) throw new Error('Invalid CLI version');
}
// Optional entries are legacy constants that upstream may derive from the
// registry instead (v0.5.95 dropped CODEX_CLIENT_VERSION from the models route).
for (const [file, constant, value, optional] of [
  ['open-sse/providers/shared.js', 'CLAUDE_CLI_VERSION', claude, false],
  ['open-sse/providers/registry/codex.js', 'CODEX_CLI_VERSION', codex, false],
  ['src/app/api/providers/[id]/models/route.js', 'CODEX_CLIENT_VERSION', codex, true],
]) {
  if (!value) continue;
  const source = fs.readFileSync(file, 'utf8');
  const pattern = new RegExp(`(${constant}\\s*=\\s*")[^"]+(";)`, 'g');
  const matches = [...source.matchAll(pattern)];
  if (optional && matches.length === 0) continue;
  if (matches.length !== 1) throw new Error(`Expected one ${constant} definition`);
  fs.writeFileSync(file, source.replace(pattern, (_, before, after) => before + value + after));
  console.log(`${constant}=${value}`);
}
