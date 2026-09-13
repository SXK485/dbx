export function ensureSqlExtension(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return trimmed;
  return /\.sql$/i.test(trimmed) ? trimmed : `${trimmed}.sql`;
}

export function stripSqlExtension(name: string): string {
  return name.replace(/\.sql$/i, "");
}

/**
 * Windows file-name rules, mirrored for friendly inline validation. The
 * filesystem remains the final authority; these checks pre-empt its errors.
 */
const WINDOWS_RESERVED_BASE_NAMES = new Set(["con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9"]);

export type InvalidSavedSqlNameReason = "empty" | "illegal-char" | "trailing-dot-space" | "reserved";

/**
 * Returns why a query name cannot become a real file name on Windows, or
 * `null` when the name is valid. Mirrors Explorer's rejection behavior:
 * illegal characters, trailing dots/spaces, and reserved device names.
 */
export function invalidSavedSqlNameReason(name: string): InvalidSavedSqlNameReason | null {
  const trimmed = name.trim();
  if (!trimmed) return "empty";
  if (/[<>:"/\\|?*\p{Cc}]/u.test(trimmed)) return "illegal-char";
  if (/[. ]$/.test(trimmed)) return "trailing-dot-space";
  const base = stripSqlExtension(trimmed).split(".")[0].toLowerCase();
  if (WINDOWS_RESERVED_BASE_NAMES.has(base)) return "reserved";
  return null;
}
