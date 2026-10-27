// Initial schema bootstrap. For fresh DB this creates all tables/indexes.
// For existing DB at version 0 (legacy unstamped), it's idempotent (IF NOT EXISTS).
import { TABLES, buildCreateTableSql } from "../schema.js";

export default {
  version: 1,
  name: "initial",
  up(db) {
    for (const [name, def] of Object.entries(TABLES)) {
      db.exec(buildCreateTableSql(name, def));
      for (const idx of def.indexes || []) {
        // A legacy unstamped DB may already have usageHistory without v4
        // columns. Let migration 004 add them before creating its new index.
        if (name === "usageHistory" && idx.includes("idx_uh_keyid_ts") &&
            !db.all("PRAGMA table_info(usageHistory)").some((column) => column.name === "apiKeyId")) continue;
        db.exec(idx);
      }
    }
  },
};
