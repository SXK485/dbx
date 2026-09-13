import { ensureSqlExtension, stripSqlExtension } from "@/lib/savedSql/savedSqlFileName";
import { currentLocale } from "@/i18n";
import type { TreeNode } from "@/types/database";

export interface SavedSqlPasteTarget {
  connectionId: string;
  catalog?: string;
  database: string;
  schema?: string;
}

export function savedSqlClipboardFileIds(nodes: readonly TreeNode[]): string[] {
  return [...new Set(nodes.filter((node) => node.type === "saved-sql-file" && !!node.savedSqlId).map((node) => node.savedSqlId!))];
}

export function savedSqlPasteTargetForNode(node: Pick<TreeNode, "type" | "connectionId" | "catalog" | "database" | "schema">): SavedSqlPasteTarget | null {
  if (node.type !== "database" && node.type !== "saved-sql-root" && node.type !== "saved-sql-file") return null;
  if (!node.connectionId || node.database === undefined) return null;
  return {
    connectionId: node.connectionId,
    catalog: node.catalog,
    database: node.database,
    schema: node.schema,
  };
}

/** Windows Explorer copy suffix for the active language (" - 副本" / " - Copy"). */
export function explorerCopySuffix(): string {
  return currentLocale().toLowerCase().startsWith("zh") ? " - 副本" : " - Copy";
}

/**
 * Explorer-style unique name for a copied query: `test - 副本.sql`, then
 * `test - 副本 (2).sql`, `test - 副本 (3).sql`, ... (or the " - Copy" family
 * in non-Chinese locales). Mirrors what Explorer does when a file is copied
 * into a folder that already contains it.
 */
export function nextSavedSqlCopyName(sourceName: string, takenNames: ReadonlySet<string>): string {
  const normalizedSource = ensureSqlExtension(sourceName);
  const sourceBase = stripSqlExtension(normalizedSource);
  const suffix = explorerCopySuffix();
  const copyBase = sourceBase.replace(new RegExp(`${escapeRegExp(suffix)}( \\(\\d+\\))?$`, "i"), "") || sourceBase;
  const normalizedTakenNames = new Set([...takenNames].map((name) => ensureSqlExtension(name).toLocaleLowerCase()));

  const first = `${copyBase}${suffix}.sql`;
  if (!normalizedTakenNames.has(first.toLocaleLowerCase())) return first;
  let index = 2;
  while (normalizedTakenNames.has(`${copyBase}${suffix} (${index}).sql`.toLocaleLowerCase())) index++;
  return `${copyBase}${suffix} (${index}).sql`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
