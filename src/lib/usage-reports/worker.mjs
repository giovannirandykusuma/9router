import { parentPort, workerData } from 'node:worker_threads';
import { openReportDatabase } from './worker-db.js';
import { queryReport } from './query.js';
import { ReportError } from './filters.js';
import { encodeReport } from './worker-output.js';

let db;
try {
  const { driver, filePath, filters, fullExport } = workerData;
  db = await openReportDatabase(driver, filePath);
  const report = queryReport(db, filters, { fullExport });
  db.close();
  db = null;
  // Neither full report objects nor raw DB rows are cloned onto the gateway
  // thread. JSON serialization and ZIP/XML generation both happen here.
  const output = await encodeReport(report, fullExport);
  parentPort.postMessage({ bytes: output.buffer }, [output.buffer]);
} catch (error) {
  // Never send SQL, paths, exception stacks or credential values to the parent.
  parentPort.postMessage({ error: error instanceof ReportError
    ? { message: error.message, status: error.status }
    : { message: 'Unable to generate usage report', status: 500 } });
} finally {
  if (db) db.close();
  parentPort.close();
}
