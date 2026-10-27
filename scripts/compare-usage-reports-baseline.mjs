// Compare full Vitest JSON across worktrees; preserve known baseline failures.
import fs from 'node:fs';
const [baselinePath, currentPath] = process.argv.slice(2);
if (!baselinePath || !currentPath) throw new Error('Usage: node scripts/compare-usage-reports-baseline.mjs baseline.json current.json');
const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
const current = JSON.parse(fs.readFileSync(currentPath, 'utf8'));
function failures(report) {
  return report.testResults.flatMap(file => file.assertionResults.filter(test => test.status === 'failed').map(test => `${file.name.split('/tests/').at(-1)} :: ${test.fullName}`));
}
const known = new Set(failures(baseline));
const now = new Set(failures(current));
const regressions = [...now].filter(name => !known.has(name));
const resolved = [...known].filter(name => !now.has(name));
const loadErrors = report => report.testResults.filter(file => file.status === 'failed' && !file.assertionResults.length).map(file => file.name.split('/tests/').at(-1));
const baselineLoads = new Set(loadErrors(baseline));
const newLoadErrors = loadErrors(current).filter(name => !baselineLoads.has(name));
console.log(JSON.stringify({ passed: current.numPassedTests, failed: current.numFailedTests, pending: current.numPendingTests, baselineFailures: known.size, currentFailures: now.size, regressions, resolved, loadErrors: loadErrors(current), newLoadErrors }, null, 2));
if (regressions.length || newLoadErrors.length) process.exitCode = 1;
