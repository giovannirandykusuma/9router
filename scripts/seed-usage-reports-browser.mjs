// Synthetic fixtures only. Refuse arbitrary destinations or nonempty history.
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
const file = "/tmp/9router-reports-synthetic-data/db/data.sqlite";
if (!fs.existsSync(file)) throw new Error("Start isolated reports-preview once to create the synthetic schema");
const db = new DatabaseSync(file);
const columns = db.prepare("PRAGMA table_info(usageHistory)").all().map(row => row.name);
if (!columns.includes("apiKeyId")) throw new Error("Reports v4 schema must be initialized first");
const count = db.prepare("SELECT COUNT(*) AS n FROM usageHistory").get().n;
if (count > 0) throw new Error("Refusing to overwrite existing history; use a fresh synthetic directory");
const key = db.prepare("INSERT INTO apiKeys(id,key,name,machineId,isActive,createdAt) VALUES(?,?,?,?,?,?)");
const insert = db.prepare("INSERT INTO usageHistory(timestamp,provider,model,connectionId,apiKey,apiKeyId,apiKeyName,promptTokens,completionTokens,cost,status,tokens,meta) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)");
db.exec("BEGIN");
try {
  for (const id of ["kenny", "other"]) {
    const name = id === "kenny" ? "Kenny (synthetic)" : "Other (synthetic)";
    key.run(id, `synthetic-raw-key-${id}`, name, "synthetic-machine", 1, "2026-10-01T00:00:00.000Z");
    for (let i = 0; i < 31; i++) {
      const tokens = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, cached_tokens: 10, reasoning_tokens: 5 };
      insert.run(`2026-10-${String(i + 1).padStart(2, "0")}T12:00:00.000Z`, "codex", "gpt-test", "account-test", `synthetic-raw-key-${id}`, id, name, 100, 20, .001, "ok", JSON.stringify(tokens), "{}");
    }
  }
  db.exec("COMMIT");
} catch (error) { db.exec("ROLLBACK"); throw error; }
db.close();
console.log(`SEEDED_SYNTHETIC_REPORTS 62 rows ${path.basename(file)}`);
