// Next cannot discover imports in a worker launched by runtime file path.
// Include its source and complete installed dependency packages (including native
// bindings), recursively. Do not rely on the build machine's absolute paths.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

export function reportWorkerAssets(projectRoot) {
  const modules = fs.realpathSync(path.join(projectRoot, 'node_modules'));
  const packages = new Set();
  function visit(name, from, optional = false) {
    const require = createRequire(path.join(from, 'package.json'));
    let manifest;
    try { manifest = require.resolve(`${name}/package.json`); }
    catch (error) { if (optional) return; throw error; }
    const directory = path.dirname(manifest);
    if (packages.has(directory)) return;
    const relative = path.relative(modules, directory);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Report dependency outside node_modules');
    packages.add(directory);
    const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    for (const dependency of Object.keys(pkg.dependencies || {})) visit(dependency, directory);
    for (const dependency of Object.keys(pkg.optionalDependencies || {})) visit(dependency, directory, true);
  }
  visit('exceljs', projectRoot);
  visit('luxon', projectRoot);
  visit('better-sqlite3', projectRoot, true);
  return ['./src/lib/usage-reports/**/*', ...[...packages].map((directory) =>
    `./node_modules/${path.relative(modules, directory).split(path.sep).join('/')}/**/*`)];
}
