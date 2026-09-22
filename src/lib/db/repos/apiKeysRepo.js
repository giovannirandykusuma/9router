import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { keyAccessFromColumns, keyAccessToColumns } from "@/shared/utils/keyAccess.js";
import { KEY_ACCESS_UNRESTRICTED } from "@/shared/constants/keyAccess.js";

// Per-key limit columns; NULL = unlimited. Enforced in src/lib/apiKeyLimits.js
export const API_KEY_LIMIT_FIELDS = [
  { name: "rpmLimit", integer: true },
  { name: "dailyTokenLimit", integer: true },
  { name: "dailyInputTokenLimit", integer: true },
  { name: "dailyOutputTokenLimit", integer: true },
  { name: "monthlyTokenLimit", integer: true },
  { name: "monthlyInputTokenLimit", integer: true },
  { name: "monthlyOutputTokenLimit", integer: true },
  { name: "monthlyRequestLimit", integer: true },
  { name: "monthlyBudget", integer: false },
];
const LIMIT_NAMES = API_KEY_LIMIT_FIELDS.map((f) => f.name);

function rowToKey(row) {
  if (!row) return null;
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    machineId: row.machineId,
    isActive: row.isActive === 1 || row.isActive === true,
    createdAt: row.createdAt,
    access: keyAccessFromColumns(row.accessRestricted, row.accessAllow),
    ...Object.fromEntries(LIMIT_NAMES.map((name) => [name, row[name] ?? null])),
  };
}

// Positive number → limit; anything else (null, 0, "", NaN) → unlimited
function normalizeLimit(value, integer) {
  const n = Number(value);
  if (value === null || value === undefined || value === "" || !Number.isFinite(n) || n <= 0) return null;
  return integer ? Math.floor(n) : n;
}

export function normalizeApiKeyLimits(data = {}) {
  return Object.fromEntries(API_KEY_LIMIT_FIELDS.map((f) => [f.name, normalizeLimit(data[f.name], f.integer)]));
}

const LIMIT_COLUMNS_SQL = LIMIT_NAMES.join(", ");
const LIMIT_PLACEHOLDERS_SQL = LIMIT_NAMES.map(() => "?").join(", ");
const LIMIT_SET_SQL = LIMIT_NAMES.map((name) => `${name} = ?`).join(", ");
const limitValues = (obj) => LIMIT_NAMES.map((name) => obj[name] ?? null);

// INSERT OR REPLACE a full key row (used by DB import)
// `access` must already be validated by the caller; absent → unrestricted.
export function insertApiKeyRow(db, k, access = KEY_ACCESS_UNRESTRICTED) {
  const cols = keyAccessToColumns(access);
  db.run(
    `INSERT OR REPLACE INTO apiKeys(id, key, name, machineId, isActive, createdAt, accessRestricted, accessAllow, ${LIMIT_COLUMNS_SQL}) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ${LIMIT_PLACEHOLDERS_SQL})`,
    [k.id, k.key, k.name || null, k.machineId || null, k.isActive === false ? 0 : 1, k.createdAt || new Date().toISOString(), cols.accessRestricted, cols.accessAllow, ...limitValues(normalizeApiKeyLimits(k))]
  );
}

export function rowToApiKey(row) {
  return rowToKey(row);
}

export async function getApiKeyByKey(key) {
  if (!key) return null;
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM apiKeys WHERE key = ?`, [key]);
  return rowToKey(row);
}

export async function getApiKeys() {
  const db = await getAdapter();
  const rows = db.all(`SELECT * FROM apiKeys ORDER BY createdAt ASC`);
  return rows.map(rowToKey);
}

export async function getApiKeyById(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
  return rowToKey(row);
}

export async function createApiKey(name, machineId, limits = {}) {
  if (!machineId) throw new Error("machineId is required");
  const db = await getAdapter();
  const { generateApiKeyWithMachine } = await import("@/shared/utils/apiKey");
  const result = generateApiKeyWithMachine(machineId);
  const apiKey = {
    id: uuidv4(),
    name,
    key: result.key,
    machineId,
    isActive: true,
    createdAt: new Date().toISOString(),
    access: { restricted: false, allow: [] },
    ...normalizeApiKeyLimits(limits),
  };
  const cols = keyAccessToColumns(KEY_ACCESS_UNRESTRICTED);
  db.run(
    `INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt, accessRestricted, accessAllow, ${LIMIT_COLUMNS_SQL}) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ${LIMIT_PLACEHOLDERS_SQL})`,
    [apiKey.id, apiKey.key, apiKey.name, apiKey.machineId, 1, apiKey.createdAt, cols.accessRestricted, cols.accessAllow, ...limitValues(apiKey)]
  );
  return apiKey;
}

export async function updateApiKey(id, data) {
  const db = await getAdapter();
  let result = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
    if (!row) return;
    const merged = { ...rowToKey(row), ...data };
    Object.assign(merged, normalizeApiKeyLimits(merged));
    const cols = keyAccessToColumns(merged.access);
    db.run(
      `UPDATE apiKeys SET key = ?, name = ?, machineId = ?, isActive = ?, accessRestricted = ?, accessAllow = ?, ${LIMIT_SET_SQL} WHERE id = ?`,
      [merged.key, merged.name, merged.machineId, merged.isActive ? 1 : 0, cols.accessRestricted, cols.accessAllow, ...limitValues(merged), id]
    );
    result = rowToKey(db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]));
  });
  return result;
}

export async function deleteApiKey(id) {
  const db = await getAdapter();
  const res = db.run(`DELETE FROM apiKeys WHERE id = ?`, [id]);
  return (res?.changes ?? 0) > 0;
}

export async function validateApiKey(key) {
  const db = await getAdapter();
  const row = db.get(`SELECT isActive FROM apiKeys WHERE key = ?`, [key]);
  if (!row) return false;
  return row.isActive === 1 || row.isActive === true;
}
