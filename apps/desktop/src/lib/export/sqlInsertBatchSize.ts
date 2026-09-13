import { safeLocalStorageGet, safeLocalStorageSet } from "@/lib/backend/safeStorage";

// Rows per INSERT statement ("rows in batch" in DBeaver terms). The value is a
// per-export choice that we remember between exports; the backend clamps it
// again and still applies its own limits (Oracle-style dialects always write a
// single row per statement, SQL Server caps at 1000 rows, and one statement
// never grows past the shared per-statement byte cap).
export const DEFAULT_SQL_INSERT_BATCH_SIZE = 100;
export const MIN_SQL_INSERT_BATCH_SIZE = 1;
export const MAX_SQL_INSERT_BATCH_SIZE = 100_000;

const STORAGE_KEY = "dbx.sqlInsertBatchSize";

export function normalizeSqlInsertBatchSize(value: unknown, fallback = DEFAULT_SQL_INSERT_BATCH_SIZE): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(MAX_SQL_INSERT_BATCH_SIZE, Math.max(MIN_SQL_INSERT_BATCH_SIZE, Math.round(numeric)));
}

/** Rows per INSERT remembered from the last export (100 until the user changes it). */
export function rememberedSqlInsertBatchSize(): number {
  const raw = safeLocalStorageGet(STORAGE_KEY);
  if (raw == null || raw.trim() === "") return DEFAULT_SQL_INSERT_BATCH_SIZE;
  return normalizeSqlInsertBatchSize(raw);
}

export function rememberSqlInsertBatchSize(value: unknown): void {
  safeLocalStorageSet(STORAGE_KEY, String(normalizeSqlInsertBatchSize(value)));
}
