import { createApp } from "vue";
import SqlInsertModeDialog from "@/components/export/SqlInsertModeDialog.vue";
import i18n from "@/i18n";
import { rememberedSqlInsertBatchSize, rememberSqlInsertBatchSize } from "@/lib/export/sqlInsertBatchSize";

export type SqlInsertMode = "batch" | "single";

export interface SqlExportOptions {
  insertMode: SqlInsertMode;
  splitMaxMb?: number;
  /** Rows per INSERT statement; only meaningful for the batch mode. */
  insertBatchSize?: number;
}

export const DEFAULT_SQL_INSERT_MODE: SqlInsertMode = "batch";

export function showSqlInsertModeDialog(options: { allowSplit?: boolean } = {}): Promise<SqlExportOptions | null> {
  const insertBatchSize = rememberedSqlInsertBatchSize();
  if (typeof document === "undefined") return Promise.resolve({ insertMode: DEFAULT_SQL_INSERT_MODE, insertBatchSize });

  return new Promise((resolve) => {
    const container = document.createElement("div");
    document.body.append(container);
    let settled = false;
    let app: ReturnType<typeof createApp> | null = null;
    const finish = (value: SqlExportOptions | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
      app?.unmount();
      container.remove();
    };
    app = createApp(SqlInsertModeDialog, {
      open: true,
      allowSplit: options.allowSplit === true,
      initialInsertBatchSize: insertBatchSize,
      onConfirm: (options: SqlExportOptions) => {
        if (options.insertBatchSize !== undefined) rememberSqlInsertBatchSize(options.insertBatchSize);
        finish(options);
      },
      onCancel: () => finish(null),
    });
    app.use(i18n);
    app.mount(container);
  });
}
