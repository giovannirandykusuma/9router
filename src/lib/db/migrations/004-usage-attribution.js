import { sealKeyHistory } from "../../usage-reports/attribution.js";
import { TABLES, buildCreateTableSql } from "../schema.js";

export default {
  version: 4,
  name: "durable inference usage key attribution",
  up(db) {
    // Versioned migrations run before additive schema sync on existing DBs.
    db.exec(buildCreateTableSql('usageHistory', TABLES.usageHistory));
    const columns = new Set(db.all('PRAGMA table_info(usageHistory)').map((c) => c.name));
    for (const name of ['apiKeyId', 'apiKeyName']) {
      if (!columns.has(name)) db.exec(`ALTER TABLE usageHistory ADD COLUMN ${name} TEXT`);
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_uh_keyid_ts ON usageHistory(apiKeyId, timestamp)');
    sealKeyHistory(db);
  },
};
