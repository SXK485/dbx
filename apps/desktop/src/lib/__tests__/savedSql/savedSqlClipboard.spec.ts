import { describe, expect, it, vi } from "vitest";
import { nextSavedSqlCopyName, savedSqlClipboardFileIds, savedSqlPasteTargetForNode } from "@/lib/savedSql/savedSqlClipboard";
import { savedSqlExportFileName } from "@/lib/savedSql/savedSqlExport";
import type { TreeNode } from "@/types/database";

vi.mock("@/i18n", () => ({ currentLocale: () => "zh-CN" }));

describe("saved SQL tree clipboard", () => {
  it("collects unique saved SQL ids from tree rows", () => {
    const nodes: TreeNode[] = [
      { id: "file-1", label: "report.sql", type: "saved-sql-file", savedSqlId: "sql-1" },
      { id: "file-1-copy", label: "report.sql", type: "saved-sql-file", savedSqlId: "sql-1" },
      { id: "table-1", label: "report", type: "table" },
    ];

    expect(savedSqlClipboardFileIds(nodes)).toEqual(["sql-1"]);
  });

  it("resolves database scope from a Queries node or saved SQL row", () => {
    expect(savedSqlPasteTargetForNode({ type: "saved-sql-root", connectionId: "conn-1", catalog: "hive", database: "app" })).toEqual({ connectionId: "conn-1", catalog: "hive", database: "app", schema: undefined });
    expect(savedSqlPasteTargetForNode({ type: "saved-sql-file", connectionId: "conn-1", database: "app", schema: "public" })).toEqual({ connectionId: "conn-1", catalog: undefined, database: "app", schema: "public" });
    expect(savedSqlPasteTargetForNode({ type: "schema", connectionId: "conn-1", database: "app", schema: "public" })).toBeNull();
  });

  it("uses Explorer-style copy suffixes for pasted queries", () => {
    expect(nextSavedSqlCopyName("query.sql", new Set(["query.sql"]))).toBe("query - 副本.sql");
    expect(nextSavedSqlCopyName("query.sql", new Set(["query.sql", "query - 副本.sql"]))).toBe("query - 副本 (2).sql");
    expect(nextSavedSqlCopyName("query - 副本.sql", new Set(["query - 副本.sql"]))).toBe("query - 副本 (2).sql");
    expect(nextSavedSqlCopyName("query.sql", new Set(["query.sql", "query - 副本.sql", "query - 副本 (2).sql"]))).toBe("query - 副本 (3).sql");
  });

  it("sanitizes exported SQL file names", () => {
    expect(savedSqlExportFileName("report<2026>:daily")).toBe("report_2026__daily.sql");
  });
});
