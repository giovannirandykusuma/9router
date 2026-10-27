// Report-only connection: never import the gateway driver, migrations or repos.
// This is trusted code with access to the DB file, not a security sandbox.
export async function openReportDatabase(driver, filePath) {
  let raw;
  if (driver === 'node:sqlite') {
    const { DatabaseSync } = await import('node:sqlite');
    raw = new DatabaseSync(filePath, { readOnly: true });
  } else if (driver === 'better-sqlite3') {
    const { default: Database } = await import('better-sqlite3');
    raw = new Database(filePath, { readonly: true, fileMustExist: true });
  } else if (driver === 'bun:sqlite') {
    const { Database } = await import('bun:sqlite');
    raw = new Database(filePath, { readonly: true });
  } else {
    throw new Error('Unsupported reporting driver');
  }
  try {
    // Bound the page cache; spill aggregate temporary tables to disk. Native
    // allocations are NOT covered by worker_threads' JavaScript heap limit.
    raw.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000; PRAGMA cache_size=-16384; PRAGMA temp_store=FILE');
    return {
      get: (sql, args = []) => raw.prepare(sql).get(...args),
      all: (sql, args = []) => raw.prepare(sql).all(...args),
      transaction(fn) {
        raw.exec('BEGIN');
        try { const value = fn(); raw.exec('COMMIT'); return value; }
        catch (error) { try { raw.exec('ROLLBACK'); } catch {} throw error; }
      },
      close: () => raw.close(),
    };
  } catch (error) {
    raw.close();
    throw error;
  }
}
