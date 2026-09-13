import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { uuid } from "@/lib/common/utils";
import * as api from "@/lib/backend/api";
import { forgetSavedSqlEditorPosition } from "@/lib/app/savedSqlEditorPosition";
import { ensureSqlExtension, invalidSavedSqlNameReason, type InvalidSavedSqlNameReason } from "@/lib/savedSql/savedSqlFileName";
import { nextSavedSqlCopyName } from "@/lib/savedSql/savedSqlClipboard";
import { savedSqlDatabaseScopeKey } from "@/lib/savedSql/savedSqlDatabaseTree";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { useSettingsStore } from "@/stores/settingsStore";
import type { SavedSqlFile, SavedSqlFolder, SavedSqlLibrary, TreeNode } from "@/types/database";

// === Navicat-style file-backed saved SQL ===

function isWindowsRuntime(): boolean {
  return typeof navigator !== "undefined" && /windows/i.test(navigator.userAgent);
}

/** `<dir>/<database>/<name>.sql` absolute path for a file-backed query. */
function savedSqlAbsPath(dir: string, relativePath: string): string {
  const separator = isWindowsRuntime() ? "\\" : "/";
  return `${dir.replace(/[\\/]+$/, "")}${separator}${relativePath.replace(/[\\/]/g, separator)}`;
}

/** Relative path under `dir`, or null when the file lives elsewhere. */
function savedSqlRelativeUnderDir(filePath: string, dir: string): string | null {
  const normalizedFile = filePath.replace(/\\/g, "/").replace(/\/+$/, "");
  const normalizedDir = dir.replace(/\\/g, "/").replace(/\/+$/, "");
  if (normalizedFile.length <= normalizedDir.length + 1) return null;
  if (!normalizedFile.toLowerCase().startsWith(normalizedDir.toLowerCase() + "/")) return null;
  return normalizedFile.slice(normalizedDir.length + 1);
}

/** Database folder name for a relative path; only `<database>/<name>.sql` files qualify. */
function savedSqlDatabaseFromRelativePath(relativePath: string): string | undefined {
  const parts = relativePath.split("/");
  return parts.length === 2 ? parts[0] : undefined;
}

/** The queries directory implied by a file path (`<dir>/<db>/<name>.sql` → `<dir>`). */
function savedSqlDirFromFilePath(filePath: string): string {
  const parts = filePath.replace(/\\/g, "/").split("/");
  parts.pop();
  parts.pop();
  return parts.join("/") || filePath;
}

const LEGACY_STORAGE_KEY = "dbx-saved-sql-library";

interface SavedSqlState {
  folders: SavedSqlFolder[];
  files: SavedSqlFile[];
}

interface SaveFileInput {
  id?: string;
  connectionId: string;
  folderId?: string;
  name: string;
  database: string;
  catalog?: string;
  schema?: string;
  sql: string;
}

interface SavedSqlExecutionTargetInput {
  connectionId: string;
  database: string;
  catalog?: string;
  schema?: string;
}

interface SavedSqlNameScope {
  id: string;
  connectionId: string;
  catalog?: string;
  database: string;
  folderId?: string;
  name: string;
}

interface PendingSavedSqlName {
  ownerId: string;
  count: number;
}

export class SavedSqlNameConflictError extends Error {
  readonly code = "SAVED_SQL_NAME_CONFLICT";

  constructor(readonly fileName: string) {
    super(`SQL "${fileName}" already exists in this location.`);
    this.name = "SavedSqlNameConflictError";
  }
}

export class SavedSqlInvalidNameError extends Error {
  readonly code = "SAVED_SQL_INVALID_NAME";

  constructor(
    readonly fileName: string,
    readonly reason: InvalidSavedSqlNameReason,
  ) {
    super(`The file name is invalid: "${fileName}"`);
    this.name = "SavedSqlInvalidNameError";
  }
}

function nowIso() {
  return new Date().toISOString();
}

function sortFoldersByOrder(items: SavedSqlFolder[]) {
  return [...items].sort((a, b) => {
    const orderDiff = (a.orderIndex ?? 0) - (b.orderIndex ?? 0);
    if (orderDiff !== 0) return orderDiff;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  });
}

function sortFilesByOrder(items: SavedSqlFile[]) {
  return [...items].sort((a, b) => {
    const orderDiff = (a.orderIndex ?? 0) - (b.orderIndex ?? 0);
    if (orderDiff !== 0) return orderDiff;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  });
}

function reindexFolders(items: SavedSqlFolder[]) {
  return items.map((folder, index) => ({ ...folder, orderIndex: index }));
}

function reindexFiles(items: SavedSqlFile[], folderId?: string) {
  return items.map((file, index) => ({
    ...file,
    folderId,
    orderIndex: index,
  }));
}

function maxOrderIndex(values: Array<{ orderIndex?: number }>) {
  return values.reduce((max, item) => Math.max(max, item.orderIndex ?? -1), -1);
}

function normalizedCatalog(catalog: string | null | undefined): string | undefined {
  return catalog || undefined;
}

function normalizeSavedSqlFile(file: SavedSqlFile): SavedSqlFile {
  return { ...file, catalog: normalizedCatalog(file.catalog) };
}

function savedSqlNameKey(name: string): string {
  return ensureSqlExtension(name).toLocaleLowerCase();
}

function savedSqlNameScopeKey(file: Pick<SavedSqlNameScope, "connectionId" | "folderId">): string {
  // Execution targets do not change the SQL library's folder-scoped names.
  return JSON.stringify(["library-folder", file.connectionId, file.folderId || null]);
}

function savedSqlNameIdentity(file: SavedSqlNameScope): string {
  return JSON.stringify([savedSqlNameScopeKey(file), savedSqlNameKey(file.name)]);
}

function savedSqlTreeIdentity(file: SavedSqlFile): string {
  return JSON.stringify([file.id, file.connectionId, normalizedCatalog(file.catalog) ?? null, file.database, file.schema ?? null, file.name]);
}

function folderDepth(items: SavedSqlFolder[], folderId: string) {
  const byId = new Map(items.map((folder) => [folder.id, folder]));
  const seen = new Set<string>();
  let depth = 0;
  let current = byId.get(folderId);
  while (current?.parentFolderId && !seen.has(current.parentFolderId)) {
    seen.add(current.parentFolderId);
    depth++;
    current = byId.get(current.parentFolderId);
  }
  return depth;
}

function loadLegacyState(): SavedSqlState {
  try {
    const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!raw) return { folders: [], files: [] };
    const parsed = JSON.parse(raw) as Partial<SavedSqlState>;
    return {
      folders: Array.isArray(parsed.folders) ? parsed.folders.filter((item) => item?.id && item?.connectionId) : [],
      files: Array.isArray(parsed.files) ? parsed.files.filter((item) => item?.id && item?.connectionId) : [],
    };
  } catch {
    return { folders: [], files: [] };
  }
}

export const useSavedSqlStore = defineStore("savedSql", () => {
  const folders = ref<SavedSqlFolder[]>([]);
  const files = ref<SavedSqlFile[]>([]);
  const isLoaded = ref(false);
  let pendingSync: Promise<void> | null = null;
  let initFromStoragePromise: Promise<void> | null = null;
  const pendingFolderCreates = new Map<string, Promise<SavedSqlFolder>>();
  const fileTargetRevisions = new Map<string, number>();
  const pendingFileTargetSaves = new Map<string, Promise<SavedSqlFile | undefined>>();
  const persistedFileTargets = new Map<string, SavedSqlExecutionTargetInput & { updatedAt: string }>();
  const pendingNamesByScope = new Map<string, Map<string, PendingSavedSqlName>>();

  // File-backed directory state: resolved queries directory per connection and
  // debounce/suppression plumbing for external file-change events.
  const fileDirsByConnection = new Map<string, string>();
  const dirRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const watchedDirs = new Set<string>();
  let dirWatchStarted = false;
  let ownWriteSuppressionUntil = 0;

  function suppressDirEvents() {
    ownWriteSuppressionUntil = Date.now() + 1200;
  }

  async function resolveConnectionSavedSqlDir(connectionId: string): Promise<string | undefined> {
    const globalDir = useSettingsStore().desktopSettings.saved_sql_base_dir?.trim() || undefined;
    let override: string | null | undefined;
    try {
      const { useConnectionStore } = await import("@/stores/connectionStore");
      override = useConnectionStore().getConfig(connectionId)?.saved_sql_dir;
    } catch {
      override = undefined;
    }
    const configured = override?.trim() || globalDir;
    if (configured) return configured;
    // Every desktop connection falls back to its own queries folder inside the
    // app data directory, so every visible database query has a real file.
    if (isTauriRuntime()) {
      try {
        return await api.defaultSavedSqlDir(connectionId);
      } catch (error) {
        console.warn("[DBX][saved-sql:default-dir]", error);
      }
    }
    return undefined;
  }

  function isFileBacked(file: SavedSqlFile): boolean {
    return Boolean(file.filePath);
  }

  async function resolveCatalogByDatabase(connectionId: string): Promise<Map<string, string | undefined>> {
    const result = new Map<string, string | undefined>();
    try {
      const { useConnectionStore } = await import("@/stores/connectionStore");
      const connectionStore = useConnectionStore();
      const walk = (nodes: readonly TreeNode[]) => {
        for (const node of nodes) {
          if (node.type === "database" && node.connectionId === connectionId && typeof node.database === "string") {
            if (!result.has(node.database)) result.set(node.database, node.catalog);
          }
          if (node.children) walk(node.children);
          if (node.hiddenChildren) walk(node.hiddenChildren);
        }
      };
      walk(connectionStore.treeNodes);
    } catch {
      // No tree available: scanned files materialize without a catalog.
    }
    return result;
  }

  function savedSqlScopeNameKey(file: Pick<SavedSqlNameScope, "connectionId" | "database" | "name">): string {
    return JSON.stringify([file.connectionId, file.database, savedSqlNameKey(file.name)]);
  }

  /**
   * Reconciles a connection's Navicat-style queries directory with the library:
   * materializes every `<database>/<name>.sql` file found on disk, refreshes
   * content of already-file-backed rows, and removes rows whose files are gone.
   * The filesystem is the source of truth; content is read here, not stored.
   */
  async function refreshConnectionDir(connectionId: string) {
    const dir = await resolveConnectionSavedSqlDir(connectionId);
    if (!dir || !isTauriRuntime()) return;

    const scanned = await api.scanSavedSqlDir(dir);
    const scanByRel = new Map<string, { name: string; sql: string }>();
    for (const entry of scanned) {
      const relative = entry.relativePath.replace(/\\/g, "/");
      if (savedSqlDatabaseFromRelativePath(relative)) scanByRel.set(relative, { name: entry.name, sql: entry.sql });
    }

    const catalogByDatabase = await resolveCatalogByDatabase(connectionId);
    const connectionFiles = files.value.filter((file) => file.connectionId === connectionId);
    const underThisDir = connectionFiles.filter((file) => file.filePath && savedSqlRelativeUnderDir(file.filePath, dir) !== null);
    const rowsByRel = new Map<string, SavedSqlFile>();
    for (const file of underThisDir) {
      const relative = savedSqlRelativeUnderDir(file.filePath!, dir);
      if (relative) rowsByRel.set(relative, file);
    }
    const rowsByScopeName = new Map<string, SavedSqlFile>();
    for (const file of connectionFiles) {
      if (file.database) rowsByScopeName.set(savedSqlScopeNameKey(file), file);
    }

    const timestamp = nowIso();
    const nextRows: SavedSqlFile[] = [];
    const consumedIds = new Set<string>();
    const removedRows = underThisDir.filter((file) => {
      const relative = savedSqlRelativeUnderDir(file.filePath!, dir)!;
      return !scanByRel.has(relative);
    });

    for (const [relative, entry] of scanByRel) {
      const database = savedSqlDatabaseFromRelativePath(relative)!;
      const filePath = savedSqlAbsPath(dir, relative);
      const existing = rowsByRel.get(relative) ?? rowsByScopeName.get(savedSqlScopeNameKey({ connectionId, database, name: entry.name }));
      const changed = !existing || existing.name !== entry.name || (existing.sqlLoaded && existing.sql !== entry.sql) || (existing.filePath ?? null) !== filePath;
      if (!existing) {
        const row: SavedSqlFile = {
          id: uuid(),
          connectionId,
          name: entry.name,
          database,
          catalog: catalogByDatabase.get(database),
          sql: entry.sql,
          sqlLoaded: true,
          filePath,
          orderIndex: maxOrderIndex(connectionFiles) + 1,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        nextRows.push(row);
        await api.saveSavedSqlFile(row).catch((error) => console.warn("[DBX][saved-sql:dir-reconcile:create]", error));
        continue;
      }
      consumedIds.add(existing.id);
      if (!changed) {
        nextRows.push(existing);
        continue;
      }
      const updated: SavedSqlFile = {
        ...existing,
        name: entry.name,
        sql: entry.sql,
        sqlLoaded: true,
        filePath,
        updatedAt: timestamp,
      };
      nextRows.push(updated);
      if (existing.filePath !== filePath) {
        await api.saveSavedSqlFile(updated).catch((error) => console.warn("[DBX][saved-sql:dir-reconcile:save]", error));
      }
    }

    // Migrate database-scoped rows that have no file yet (legacy internal
    // queries) into real files, so every visible query has a folder location.
    for (const row of connectionFiles) {
      if (!row.database || row.filePath || consumedIds.has(row.id)) continue;
      const loaded = row.sqlLoaded ? row : await api.loadSavedSqlFile(row.id).catch(() => undefined);
      if (!loaded) {
        nextRows.push(row);
        consumedIds.add(row.id);
        continue;
      }
      const relative = `${row.database}/${row.name}`.replace(/\\/g, "/");
      if (scanByRel.has(relative)) {
        nextRows.push(row);
        consumedIds.add(row.id);
        continue;
      }
      const filePath = savedSqlAbsPath(dir, relative);
      try {
        await api.writeSavedSqlDirFile(filePath, loaded.sql);
        suppressDirEvents();
        const migrated: SavedSqlFile = { ...row, sql: loaded.sql, sqlLoaded: true, filePath, updatedAt: timestamp };
        nextRows.push(migrated);
        await api.saveSavedSqlFile(migrated).catch((error) => console.warn("[DBX][saved-sql:dir-migrate:save]", error));
      } catch (error) {
        console.warn("[DBX][saved-sql:dir-migrate]", error);
        nextRows.push(row);
      }
      consumedIds.add(row.id);
    }

    // Relocate rows left over from the previous default location (the app
    // data `queries` folder) into the new default directory under Documents.
    let legacyQueriesRoot = "";
    try {
      legacyQueriesRoot = `${(await api.savedSqlStorageDir()).replace(/[\\/]+$/, "")}/queries`;
    } catch {
      legacyQueriesRoot = "";
    }
    for (const row of connectionFiles) {
      if (!row.database || !row.filePath || consumedIds.has(row.id) || !legacyQueriesRoot) continue;
      if (savedSqlRelativeUnderDir(row.filePath, legacyQueriesRoot) === null) continue;
      if (savedSqlRelativeUnderDir(row.filePath, dir) !== null) continue;
      const loaded = row.sqlLoaded ? row : await api.loadSavedSqlFile(row.id).catch(() => undefined);
      const relative = `${row.database}/${row.name}`.replace(/\\/g, "/");
      const filePath = savedSqlAbsPath(dir, relative);
      try {
        await api.writeSavedSqlDirFile(filePath, loaded?.sql ?? row.sql);
        suppressDirEvents();
        await api.deleteSavedSqlDirFile(legacyQueriesRoot, row.filePath).catch(() => {});
        const relocated: SavedSqlFile = { ...row, sql: loaded?.sql ?? row.sql, sqlLoaded: true, filePath, updatedAt: timestamp };
        nextRows.push(relocated);
        await api.saveSavedSqlFile(relocated).catch((error) => console.warn("[DBX][saved-sql:dir-relocate:save]", error));
      } catch (error) {
        console.warn("[DBX][saved-sql:dir-relocate]", error);
        nextRows.push(row);
      }
      consumedIds.add(row.id);
    }

    const fileIdsToDelete = new Set(removedRows.map((file) => file.id));
    for (const file of removedRows) {
      await api.deleteSavedSqlFile(file.id).catch((error) => console.warn("[DBX][saved-sql:dir-reconcile:delete]", error));
    }

    const nextIds = new Set(nextRows.map((file) => file.id));
    files.value = [
      ...files.value.filter((file) => {
        if (fileIdsToDelete.has(file.id)) return false;
        if (nextIds.has(file.id)) return false;
        if (file.connectionId === connectionId && file.filePath && savedSqlRelativeUnderDir(file.filePath, dir) !== null) return false;
        return true;
      }),
      ...nextRows,
    ];
    fileDirsByConnection.set(connectionId, dir);
    bumpVersion({ tree: true });
    await syncToLocalDirectory();
  }

  async function startDirWatching() {
    if (dirWatchStarted || !isTauriRuntime()) return;
    dirWatchStarted = true;
    try {
      const { listen } = await import("@tauri-apps/api/event");
      await listen<string>("saved-sql-dir-changed", (event) => {
        if (Date.now() < ownWriteSuppressionUntil) return;
        scheduleDirRefresh(event.payload);
      });
    } catch (error) {
      console.warn("[DBX][saved-sql:dir-watch:start]", error);
    }
  }

  function scheduleDirRefresh(dir: string) {
    const key = dir.toLowerCase();
    const pending = dirRefreshTimers.get(key);
    if (pending) clearTimeout(pending);
    dirRefreshTimers.set(
      key,
      setTimeout(() => {
        dirRefreshTimers.delete(key);
        void refreshConnectionsForDir(dir);
      }, 400),
    );
  }

  async function refreshConnectionsForDir(dir: string) {
    try {
      const { useConnectionStore } = await import("@/stores/connectionStore");
      const connectionStore = useConnectionStore();
      for (const config of connectionStore.connections) {
        // Resolve each connection's full directory chain (override → global →
        // default) so events from default-location folders refresh too.
        const resolved = await resolveConnectionSavedSqlDir(config.id).catch(() => undefined);
        if (resolved && resolved.toLowerCase() === dir.toLowerCase()) {
          await refreshConnectionDir(config.id).catch((error) => console.warn("[DBX][saved-sql:dir-refresh:error]", error));
        }
      }
    } catch (error) {
      console.warn("[DBX][saved-sql:dir-refresh:error]", error);
    }
  }

  /**
   * Copies `.sql` files from the system clipboard (or an explicit path list)
   * into `<queries_dir>/<database>/` with Explorer-style unique naming
   * (`test - 副本.sql`, `test - 副本 (2).sql`, ...) and refreshes the library
   * immediately.
   */
  async function pasteFilesIntoDatabase(connectionId: string, database: string, paths: string[]): Promise<string[]> {
    const dir = await resolveConnectionSavedSqlDir(connectionId);
    if (!dir || !isTauriRuntime() || paths.length === 0) return [];
    const taken = new Set(files.value.filter((file) => file.connectionId === connectionId && file.database === database).map((file) => file.name));
    const created: string[] = [];
    for (const path of paths) {
      const sourceName = path.split(/[\\/]/).pop() || "query.sql";
      const targetName = nextSavedSqlCopyName(sourceName, taken);
      taken.add(targetName);
      try {
        suppressDirEvents();
        const target = await api.pasteSavedSqlFile(dir, database, path, targetName);
        created.push(target);
      } catch (error) {
        console.warn("[DBX][saved-sql:paste-file]", error);
      }
    }
    if (created.length > 0) {
      await refreshConnectionDir(connectionId).catch((error) => console.warn("[DBX][saved-sql:paste-refresh]", error));
    }
    return created;
  }

  /** (Re)wires directory watching and refresh for every configured connection. */
  async function reconcileFileBackedDirectories() {
    await startDirWatching();
    if (!isTauriRuntime()) return;
    // Directory reconciliation must see the loaded library, otherwise it would
    // migrate/relocate against an empty file list.
    if (!isLoaded.value) {
      await initFromStorage();
    }
    try {
      const { useConnectionStore } = await import("@/stores/connectionStore");
      const connectionStore = useConnectionStore();
      const wanted = new Set<string>();
      for (const config of connectionStore.connections) {
        const dir = await resolveConnectionSavedSqlDir(config.id).catch(() => undefined);
        if (!dir) continue;
        wanted.add(dir);
        await api.watchSavedSqlDir(dir).catch(() => {});
        await refreshConnectionDir(config.id).catch((error) => console.warn("[DBX][saved-sql:dir-init:error]", error));
      }
      for (const dir of watchedDirs) {
        if (!wanted.has(dir)) {
          await api.unwatchSavedSqlDir(dir).catch(() => {});
        }
      }
      watchedDirs.clear();
      for (const dir of wanted) watchedDirs.add(dir);
    } catch (error) {
      console.warn("[DBX][saved-sql:dir-init:error]", error);
    }
  }

  const version = ref(0);
  const treeVersion = ref(0);
  function bumpVersion(options: { tree?: boolean } = {}) {
    version.value++;
    if (options.tree) treeVersion.value++;
  }

  function applyLibrary(library: SavedSqlLibrary) {
    folders.value = library.folders;
    files.value = library.files.map((file) => ({ ...normalizeSavedSqlFile(file), sqlLoaded: file.sqlLoaded ?? Boolean(file.sql) }));
    bumpVersion({ tree: true });
  }

  async function migrateLegacyLocalStorage() {
    const legacy = loadLegacyState();
    if (legacy.folders.length === 0 && legacy.files.length === 0) return;

    for (const folder of legacy.folders) {
      await api.saveSavedSqlFolder(folder);
    }
    for (const file of legacy.files) {
      await api.saveSavedSqlFile(file);
    }
    localStorage.removeItem(LEGACY_STORAGE_KEY);
  }

  async function initFromStorage() {
    if (isLoaded.value) return;
    if (!initFromStoragePromise) {
      initFromStoragePromise = (async () => {
        await migrateLegacyLocalStorage();
        applyLibrary(await api.loadSavedSqlLibrary());
        isLoaded.value = true;
      })().finally(() => {
        initFromStoragePromise = null;
      });
    }
    await initFromStoragePromise;
  }

  function listFolders(connectionId: string) {
    return listChildFolders(connectionId);
  }

  function listChildFolders(connectionId: string, parentFolderId?: string) {
    return sortFoldersByOrder(folders.value.filter((folder) => folder.connectionId === connectionId && (folder.parentFolderId || "") === (parentFolderId || "")));
  }

  function listFiles(connectionId: string, folderId?: string) {
    return sortFilesByOrder(files.value.filter((file) => file.connectionId === connectionId && (file.folderId || "") === (folderId || "")));
  }

  function folderCreateKey(connectionId: string, name: string, parentFolderId?: string) {
    return JSON.stringify([connectionId, parentFolderId || "", name]);
  }

  function getFile(id: string) {
    return files.value.find((file) => file.id === id);
  }

  function reserveFileName(file: SavedSqlNameScope): () => void {
    const scopeKey = savedSqlNameScopeKey(file);
    const nameKey = savedSqlNameKey(file.name);
    const persistedConflict = files.value.some((candidate) => candidate.id !== file.id && savedSqlNameScopeKey(candidate) === scopeKey && savedSqlNameKey(candidate.name) === nameKey);
    if (persistedConflict) throw new SavedSqlNameConflictError(file.name);

    let pendingNames = pendingNamesByScope.get(scopeKey);
    if (!pendingNames) {
      pendingNames = new Map<string, PendingSavedSqlName>();
      pendingNamesByScope.set(scopeKey, pendingNames);
    }
    const pending = pendingNames.get(nameKey);
    if (pending && pending.ownerId !== file.id) throw new SavedSqlNameConflictError(file.name);
    if (pending) pending.count++;
    else pendingNames.set(nameKey, { ownerId: file.id, count: 1 });

    let released = false;
    return () => {
      if (released) return;
      released = true;
      const currentNames = pendingNamesByScope.get(scopeKey);
      const current = currentNames?.get(nameKey);
      if (!current || current.ownerId !== file.id) return;
      current.count--;
      if (current.count <= 0) currentNames?.delete(nameKey);
      if (currentNames?.size === 0) pendingNamesByScope.delete(scopeKey);
    };
  }

  function pendingFileNames(scopeKey: string): string[] {
    return [...(pendingNamesByScope.get(scopeKey)?.keys() ?? [])];
  }

  async function ensureFileContent(id: string) {
    const existing = getFile(id);
    if (!existing) return undefined;
    if (existing.filePath && isTauriRuntime()) {
      try {
        const sql = await api.readSavedSqlDirFile(existing.filePath);
        const hydrated = { ...existing, sql, sqlLoaded: true };
        files.value = files.value.map((file) => (file.id === id ? hydrated : file));
        return hydrated;
      } catch (error) {
        console.warn("[DBX][saved-sql:file-read:error]", error);
      }
    }
    if (existing.sqlLoaded !== false) return existing;

    const loaded = await api.loadSavedSqlFile(id);
    if (!loaded) return existing;
    const hydrated = { ...normalizeSavedSqlFile(loaded), sqlLoaded: true };
    files.value = files.value.map((file) => (file.id === id ? hydrated : file));
    bumpVersion();
    return hydrated;
  }

  async function createFolder(connectionId: string, name: string, parentFolderId?: string) {
    const key = folderCreateKey(connectionId, name, parentFolderId);
    const pending = pendingFolderCreates.get(key);
    if (pending) return pending;

    const createPromise = (async () => {
      const timestamp = nowIso();
      const folder: SavedSqlFolder = {
        id: uuid(),
        connectionId,
        parentFolderId: parentFolderId || undefined,
        name,
        orderIndex: maxOrderIndex(folders.value.filter((item) => item.connectionId === connectionId && (item.parentFolderId || "") === (parentFolderId || ""))) + 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const saved = await api.saveSavedSqlFolder(folder);
      folders.value = [...folders.value.filter((item) => item.id !== saved.id), saved];
      bumpVersion();
      await syncToLocalDirectory();
      return saved;
    })();

    pendingFolderCreates.set(key, createPromise);
    try {
      return await createPromise;
    } finally {
      if (pendingFolderCreates.get(key) === createPromise) {
        pendingFolderCreates.delete(key);
      }
    }
  }

  async function renameFolder(id: string, name: string) {
    const existing = folders.value.find((folder) => folder.id === id);
    if (!existing) return;
    const saved = await api.saveSavedSqlFolder({ ...existing, name, updatedAt: nowIso() });
    folders.value = folders.value.map((folder) => (folder.id === id ? saved : folder));
    bumpVersion();
    await syncToLocalDirectory();
  }

  async function deleteFolder(id: string) {
    const removedIds = descendantFolderIds(id);
    const removesFiles = files.value.some((file) => !!file.folderId && removedIds.has(file.folderId));
    for (const file of files.value.filter((file) => file.folderId && removedIds.has(file.folderId))) {
      if (file.filePath && isTauriRuntime()) {
        const dir = fileDirsByConnection.get(file.connectionId) ?? savedSqlDirFromFilePath(file.filePath);
        suppressDirEvents();
        await api.deleteSavedSqlDirFile(dir, file.filePath).catch((error) => console.warn("[DBX][saved-sql:file-delete:error]", error));
      }
    }
    await api.deleteSavedSqlFolder(id);
    folders.value = folders.value.filter((folder) => !removedIds.has(folder.id));
    files.value = files.value.filter((file) => !file.folderId || !removedIds.has(file.folderId));
    bumpVersion({ tree: removesFiles });
    await syncToLocalDirectory();
  }

  async function saveFile(input: SaveFileInput) {
    const timestamp = nowIso();
    const existing = input.id ? getFile(input.id) : undefined;
    const catalog = normalizedCatalog(input.catalog);
    const hasFolderIdInput = Object.prototype.hasOwnProperty.call(input, "folderId");
    const invalidReason = invalidSavedSqlNameReason(input.name);
    if (invalidReason) throw new SavedSqlInvalidNameError(input.name, invalidReason);
    const safeName = ensureSqlExtension(input.name.trim());
    const file: SavedSqlFile = existing
      ? {
          ...existing,
          // Partial metadata updates should not move files out of their folder.
          // Callers that intentionally move to root pass `folderId: undefined`.
          folderId: hasFolderIdInput ? input.folderId || undefined : existing.folderId,
          name: safeName,
          database: input.database,
          schema: input.schema,
          sql: input.sql,
          sqlLoaded: true,
          connectionId: input.connectionId,
          catalog,
          updatedAt: timestamp,
        }
      : {
          id: uuid(),
          connectionId: input.connectionId,
          catalog,
          folderId: input.folderId || undefined,
          name: safeName,
          database: input.database,
          schema: input.schema,
          sql: input.sql,
          sqlLoaded: true,
          orderIndex: maxOrderIndex(files.value.filter((file) => file.connectionId === input.connectionId && (file.folderId || "") === (input.folderId || undefined || ""))) + 1,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
    const nameIdentityChanged = !existing || savedSqlNameIdentity(existing) !== savedSqlNameIdentity(file);
    const releaseName = nameIdentityChanged ? reserveFileName(file) : undefined;
    try {
      const filePath = await persistFileToDisk(input.connectionId, file, existing);
      const saved = normalizeSavedSqlFile(await api.saveSavedSqlFile({ ...file, filePath }));
      files.value = [...files.value.filter((item) => item.id !== saved.id), { ...saved, sqlLoaded: true }];
      bumpVersion({ tree: !existing || savedSqlTreeIdentity(existing) !== savedSqlTreeIdentity(saved) });
      await syncToLocalDirectory();
      return saved;
    } finally {
      releaseName?.();
    }
  }

  /**
   * Writes a database-scoped query to its Navicat-style directory and returns
   * the file path. Internal (library) files are left untouched.
   */
  async function persistFileToDisk(connectionId: string, file: SavedSqlFile, existing?: SavedSqlFile): Promise<string | null> {
    if (!isTauriRuntime() || !file.database) return existing?.filePath ?? null;
    const dir = (await resolveConnectionSavedSqlDir(connectionId)) || (existing?.filePath ? savedSqlDirFromFilePath(existing.filePath) : undefined);
    if (!dir) return existing?.filePath ?? null;

    const candidatePath = savedSqlAbsPath(dir, `${file.database}/${file.name}`);
    const previousPath = existing?.filePath ?? null;
    suppressDirEvents();
    if (previousPath && previousPath.toLowerCase() !== candidatePath.toLowerCase()) {
      await api.renameSavedSqlDirFile(dir, previousPath, candidatePath);
    }
    await api.writeSavedSqlDirFile(candidatePath, file.sql);
    return candidatePath;
  }

  function updateFileExecutionTarget(id: string, target: SavedSqlExecutionTargetInput): Promise<SavedSqlFile | undefined> {
    const existing = getFile(id);
    if (!existing) return Promise.resolve(undefined);
    const normalizedTarget = { ...target, catalog: normalizedCatalog(target.catalog) };
    if (existing.connectionId === normalizedTarget.connectionId && normalizedCatalog(existing.catalog) === normalizedTarget.catalog && existing.database === normalizedTarget.database && existing.schema === normalizedTarget.schema) {
      return Promise.resolve(existing);
    }

    if (!persistedFileTargets.has(id)) {
      persistedFileTargets.set(id, {
        connectionId: existing.connectionId,
        catalog: normalizedCatalog(existing.catalog),
        database: existing.database,
        schema: existing.schema,
        updatedAt: existing.updatedAt,
      });
    }
    const revision = (fileTargetRevisions.get(id) ?? 0) + 1;
    fileTargetRevisions.set(id, revision);
    files.value = files.value.map((file) => (file.id === id ? { ...file, ...normalizedTarget, updatedAt: nowIso() } : file));
    bumpVersion({ tree: true });

    const previousSave = pendingFileTargetSaves.get(id) ?? Promise.resolve(undefined);
    const save = previousSave
      .catch(() => undefined)
      .then(async () => {
        if (fileTargetRevisions.get(id) !== revision) return getFile(id);

        const loaded = await ensureFileContent(id);
        if (!loaded || fileTargetRevisions.get(id) !== revision) return getFile(id);

        const candidate: SavedSqlFile = {
          ...loaded,
          ...normalizedTarget,
          sqlLoaded: true,
          updatedAt: nowIso(),
        };
        files.value = files.value.map((file) => (file.id === id ? candidate : file));
        bumpVersion();

        const persistedTarget = persistedFileTargets.get(id);
        const persistedNameIdentity = persistedTarget
          ? savedSqlNameIdentity({
              ...candidate,
              connectionId: persistedTarget.connectionId,
              catalog: persistedTarget.catalog,
              database: persistedTarget.database,
            })
          : savedSqlNameIdentity(candidate);
        let releaseName: (() => void) | undefined;
        try {
          if (persistedNameIdentity !== savedSqlNameIdentity(candidate)) releaseName = reserveFileName(candidate);
          const saved = normalizeSavedSqlFile(await api.saveSavedSqlFile(candidate));
          persistedFileTargets.set(id, {
            connectionId: saved.connectionId,
            catalog: normalizedCatalog(saved.catalog),
            database: saved.database,
            schema: saved.schema,
            updatedAt: saved.updatedAt,
          });
          if (fileTargetRevisions.get(id) !== revision) return getFile(id);
          const current = getFile(id);
          const persisted = { ...saved, sql: current?.sql ?? saved.sql, sqlLoaded: current?.sqlLoaded ?? true };
          files.value = files.value.map((file) => (file.id === id ? persisted : file));
          bumpVersion();
          await syncToLocalDirectory();
          return persisted;
        } catch (error) {
          if (fileTargetRevisions.get(id) === revision) {
            const persistedTarget = persistedFileTargets.get(id);
            if (persistedTarget) files.value = files.value.map((file) => (file.id === id ? { ...file, ...persistedTarget } : file));
            bumpVersion({ tree: true });
          }
          throw error;
        } finally {
          releaseName?.();
        }
      });

    pendingFileTargetSaves.set(id, save);
    const cleanup = () => {
      if (pendingFileTargetSaves.get(id) !== save) return;
      pendingFileTargetSaves.delete(id);
      persistedFileTargets.delete(id);
    };
    void save.then(cleanup, cleanup);
    return save;
  }

  async function renameFile(id: string, name: string) {
    const existing = getFile(id);
    if (!existing) return;
    const invalidReason = invalidSavedSqlNameReason(name);
    if (invalidReason) throw new SavedSqlInvalidNameError(name, invalidReason);
    const normalizedName = ensureSqlExtension(name.trim());
    if (normalizedName === existing.name) return existing;
    const candidate = { ...existing, name: normalizedName, updatedAt: nowIso() };
    const releaseName = reserveFileName(candidate);
    try {
      let nextFilePath = existing.filePath ?? null;
      if (existing.filePath && existing.database && isTauriRuntime()) {
        const dir = fileDirsByConnection.get(existing.connectionId) ?? savedSqlDirFromFilePath(existing.filePath);
        const targetPath = savedSqlAbsPath(dir, `${existing.database}/${normalizedName}`);
        suppressDirEvents();
        if (existing.filePath.toLowerCase() !== targetPath.toLowerCase()) {
          await api.renameSavedSqlDirFile(dir, existing.filePath, targetPath);
        }
        nextFilePath = targetPath;
      }
      const saved = normalizeSavedSqlFile(await api.saveSavedSqlFile({ ...candidate, filePath: nextFilePath }));
      files.value = files.value.map((file) => (file.id === id ? { ...saved, sql: file.sql, sqlLoaded: file.sqlLoaded } : file));
      bumpVersion({ tree: true });

      const { useQueryStore } = await import("@/stores/queryStore");
      const queryStore = useQueryStore();
      for (const tab of queryStore.tabs) {
        if (tab.savedSqlId === id) {
          tab.title = saved.name;
          tab.customTitle = true;
        }
      }

      await syncToLocalDirectory();
      return saved;
    } finally {
      releaseName();
    }
  }

  async function copyFilesToDatabase(fileIds: readonly string[], target: SavedSqlExecutionTargetInput): Promise<SavedSqlFile[]> {
    const uniqueFileIds = [...new Set(fileIds)];
    const normalizedTarget = { ...target, catalog: normalizedCatalog(target.catalog) };
    const copies: SavedSqlFile[] = [];

    for (const fileId of uniqueFileIds) {
      const source = await ensureFileContent(fileId);
      if (!source) continue;
      const sourceFolder = source.folderId ? folders.value.find((folder) => folder.id === source.folderId) : undefined;
      const folderId = sourceFolder?.connectionId === normalizedTarget.connectionId ? source.folderId : undefined;
      const copyScope = { ...normalizedTarget, folderId };
      const scopeKey = savedSqlNameScopeKey(copyScope);
      const takenNames = new Set([...files.value.filter((file) => savedSqlNameScopeKey(file) === scopeKey).map((file) => file.name), ...pendingFileNames(scopeKey)]);
      const name = nextSavedSqlCopyName(source.name, takenNames);
      const keepSourceScope = savedSqlDatabaseScopeKey(source) === savedSqlDatabaseScopeKey(normalizedTarget);
      const saved = await saveFile({
        connectionId: normalizedTarget.connectionId,
        catalog: normalizedTarget.catalog,
        folderId,
        name,
        database: normalizedTarget.database,
        schema: keepSourceScope ? source.schema : normalizedTarget.schema,
        sql: source.sql,
      });
      copies.push({ ...saved, sqlLoaded: true });
    }

    return copies;
  }

  async function recordFileUsage(id: string) {
    const existing = getFile(id);
    if (!existing) return;
    try {
      const saved = await api.saveSavedSqlFile({
        ...existing,
        openCount: (existing.openCount ?? 0) + 1,
        openedAt: nowIso(),
      });
      files.value = files.value.map((file) => (file.id === id ? { ...saved, sql: file.sql, sqlLoaded: file.sqlLoaded } : file));
      bumpVersion();
      return saved;
    } catch (error) {
      console.warn("[DBX][saved-sql:usage:error]", error);
      return existing;
    }
  }

  async function deleteFile(id: string) {
    const existing = getFile(id);
    if (existing?.filePath && isTauriRuntime()) {
      const dir = fileDirsByConnection.get(existing.connectionId) ?? savedSqlDirFromFilePath(existing.filePath);
      suppressDirEvents();
      await api.deleteSavedSqlDirFile(dir, existing.filePath).catch((error) => console.warn("[DBX][saved-sql:file-delete:error]", error));
    }
    await api.deleteSavedSqlFile(id);
    files.value = files.value.filter((file) => file.id !== id);
    bumpVersion({ tree: true });
    await syncToLocalDirectory();

    // Close all tabs that reference this saved SQL file
    const { useQueryStore } = await import("@/stores/queryStore");
    const queryStore = useQueryStore();
    const tabsToClose = queryStore.tabs.filter((tab) => tab.savedSqlId === id);
    for (const tab of tabsToClose) {
      queryStore.closeTab(tab.id, { force: true });
    }
    forgetSavedSqlEditorPosition(id);
  }

  async function persistFolders(nextFolders: SavedSqlFolder[]) {
    const reindexed = nextFolders.map((folder) => ({ ...folder, updatedAt: folder.updatedAt || nowIso() }));
    await Promise.all(reindexed.map((folder) => api.saveSavedSqlFolder(folder)));
    folders.value = reindexed;
    bumpVersion();
    await syncToLocalDirectory();
  }

  async function persistFiles(nextFiles: SavedSqlFile[]) {
    const previousTreeIdentities = new Map(files.value.map((file) => [file.id, savedSqlTreeIdentity(file)]));
    const previousNameIdentities = new Map(files.value.map((file) => [file.id, savedSqlNameIdentity(file)]));
    const releaseNames: Array<() => void> = [];
    try {
      for (const file of nextFiles) {
        if (previousNameIdentities.get(file.id) !== savedSqlNameIdentity(file)) releaseNames.push(reserveFileName(file));
      }
      const savedFiles = await Promise.all(nextFiles.map((file) => api.saveSavedSqlFile(file)));
      files.value = savedFiles.map((saved) => {
        const existing = files.value.find((file) => file.id === saved.id);
        return { ...normalizeSavedSqlFile(saved), sql: existing?.sql ?? saved.sql, sqlLoaded: existing?.sqlLoaded ?? saved.sqlLoaded };
      });
      const treeChanged = files.value.length !== previousTreeIdentities.size || files.value.some((file) => previousTreeIdentities.get(file.id) !== savedSqlTreeIdentity(file));
      bumpVersion({ tree: treeChanged });
      await syncToLocalDirectory();
    } finally {
      for (const releaseName of releaseNames) releaseName();
    }
  }

  async function syncEntries() {
    if (files.value.some((file) => file.sqlLoaded === false)) {
      const loadedFiles = await api.loadSavedSqlFilesForSync();
      const loadedById = new Map(loadedFiles.map((file) => [file.id, file]));
      files.value = files.value.map((file) => {
        if (file.sqlLoaded !== false) return file;
        const loaded = loadedById.get(file.id);
        return loaded ? { ...file, sql: loaded.sql, sqlLoaded: true } : file;
      });
      bumpVersion();
    }

    const folderById = new Map(folders.value.map((folder) => [folder.id, folder]));
    const folderPath = (folderId?: string): string | undefined => {
      if (!folderId) return undefined;
      const parts: string[] = [];
      const seen = new Set<string>();
      let current = folderById.get(folderId);
      while (current && !seen.has(current.id)) {
        seen.add(current.id);
        parts.unshift(current.name);
        current = current.parentFolderId ? folderById.get(current.parentFolderId) : undefined;
      }
      return parts.join("/");
    };
    const unloadedFile = files.value.find((file) => file.sqlLoaded === false);
    if (unloadedFile) throw new Error(`Saved SQL file '${unloadedFile.id}' could not be loaded for directory sync.`);

    return sortFilesByOrder(files.value).map((file) => ({
      folderName: folderPath(file.folderId),
      fileName: file.name,
      sql: file.sql,
    }));
  }

  async function syncToLocalDirectory() {
    if (!isTauriRuntime()) return;
    const settingsStore = useSettingsStore();
    const targetDir = settingsStore.desktopSettings.saved_sql_sync_dir?.trim();
    if (!targetDir) return;

    const entries = await syncEntries();
    const syncPromise = pendingSync?.catch(() => {}).then(() => api.syncSavedSqlDirectory({ targetDir, entries })) ?? api.syncSavedSqlDirectory({ targetDir, entries });
    pendingSync = syncPromise;
    try {
      await syncPromise;
    } catch (error) {
      console.warn("[DBX][saved-sql:sync:error]", error);
    } finally {
      if (pendingSync === syncPromise) {
        pendingSync = null;
      }
    }
  }

  async function reorderFolders(draggedId: string, targetId: string, position: "before" | "after") {
    const dragged = folders.value.find((folder) => folder.id === draggedId);
    const target = folders.value.find((folder) => folder.id === targetId);
    if (!dragged || !target || dragged.id === target.id) return;
    if (descendantFolderIds(draggedId).has(targetId)) return;

    const timestamp = nowIso();
    const targetParentFolderId = target.parentFolderId || undefined;
    const previousParentFolderId = dragged.parentFolderId || undefined;
    const ordered = sortFoldersByOrder(folders.value.filter((folder) => (folder.parentFolderId || "") === (targetParentFolderId || "")));
    const remaining = ordered.filter((folder) => folder.id !== draggedId);
    const targetIndex = remaining.findIndex((folder) => folder.id === targetId);
    const insertIndex = position === "before" ? targetIndex : targetIndex + 1;
    remaining.splice(insertIndex, 0, { ...dragged, parentFolderId: targetParentFolderId, updatedAt: timestamp });

    const updatedTargetGroup = reindexFolders(remaining).map((folder) => ({
      ...folder,
      parentFolderId: targetParentFolderId,
      updatedAt: timestamp,
    }));
    const updatedSourceGroup =
      previousParentFolderId === targetParentFolderId
        ? []
        : reindexFolders(sortFoldersByOrder(folders.value.filter((folder) => folder.id !== draggedId && (folder.parentFolderId || "") === (previousParentFolderId || "")))).map((folder) => ({
            ...folder,
            updatedAt: timestamp,
          }));
    const untouched = folders.value.filter((folder) => folder.id !== draggedId && (folder.parentFolderId || "") !== (targetParentFolderId || "") && (folder.parentFolderId || "") !== (previousParentFolderId || ""));
    await persistFolders([...untouched, ...updatedSourceGroup, ...updatedTargetGroup]);
  }

  function descendantFolderIds(folderId: string) {
    const ids = new Set<string>([folderId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const folder of folders.value) {
        if (folder.parentFolderId && ids.has(folder.parentFolderId) && !ids.has(folder.id)) {
          ids.add(folder.id);
          changed = true;
        }
      }
    }
    return ids;
  }

  async function moveFolderToFolder(folderId: string, parentFolderId?: string) {
    const target = folders.value.find((folder) => folder.id === folderId);
    if (!target) return;
    const nextParentFolderId = parentFolderId || undefined;
    if ((target.parentFolderId || undefined) === nextParentFolderId) return;
    if (nextParentFolderId && descendantFolderIds(folderId).has(nextParentFolderId)) return;

    const timestamp = nowIso();
    const previousParentFolderId = target.parentFolderId || undefined;
    const sourceGroup = reindexFolders(sortFoldersByOrder(folders.value.filter((folder) => folder.id !== folderId && (folder.parentFolderId || "") === (previousParentFolderId || "")))).map((folder) => ({ ...folder, updatedAt: timestamp }));
    const destinationGroup = reindexFolders([...sortFoldersByOrder(folders.value.filter((folder) => folder.id !== folderId && (folder.parentFolderId || "") === (nextParentFolderId || ""))), { ...target, parentFolderId: nextParentFolderId, updatedAt: timestamp }]).map((folder) => ({
      ...folder,
      parentFolderId: nextParentFolderId,
      updatedAt: timestamp,
    }));
    const untouched = folders.value.filter((folder) => folder.id !== folderId && (folder.parentFolderId || "") !== (previousParentFolderId || "") && (folder.parentFolderId || "") !== (nextParentFolderId || ""));
    await persistFolders([...untouched, ...sourceGroup, ...destinationGroup]);
  }

  async function moveFileToFolder(fileId: string, folderId?: string) {
    const target = files.value.find((file) => file.id === fileId);
    if (!target) return;
    const targetFolderId = folderId || undefined;
    if ((target.folderId || undefined) === targetFolderId) return;

    const timestamp = nowIso();
    const sourceGroup = sortFilesByOrder(files.value.filter((file) => (file.folderId || "") === (target.folderId || ""))).filter((file) => file.id !== fileId);
    const destinationGroup = sortFilesByOrder(files.value.filter((file) => file.id !== fileId && (file.folderId || "") === (targetFolderId || "")));

    const movedFile: SavedSqlFile = {
      ...target,
      folderId: targetFolderId,
      updatedAt: timestamp,
    };

    const nextSource = reindexFiles(sourceGroup, target.folderId || undefined).map((file) => ({
      ...file,
      updatedAt: timestamp,
    }));
    const nextDestination = reindexFiles([...destinationGroup, movedFile], targetFolderId).map((file) => ({
      ...file,
      updatedAt: timestamp,
    }));

    const untouched = files.value.filter((file) => file.id !== fileId && (file.folderId || "") !== (target.folderId || "") && (file.folderId || "") !== (targetFolderId || ""));

    await persistFiles([...untouched, ...nextSource, ...nextDestination]);
  }

  async function moveFilesToFolder(fileIds: string[], folderId?: string) {
    const uniqueIds = [...new Set(fileIds)];
    if (uniqueIds.length === 0) return;

    const targetFolderId = folderId || undefined;
    const movingFiles = uniqueIds.map((id) => files.value.find((file) => file.id === id)).filter((file): file is SavedSqlFile => Boolean(file));
    const filesToMove = movingFiles.filter((file) => (file.folderId || undefined) !== targetFolderId);
    if (filesToMove.length === 0) return;
    const moveIdSet = new Set(filesToMove.map((file) => file.id));

    const timestamp = nowIso();
    const affectedFolderIds = new Set<string>(filesToMove.map((file) => file.folderId || ""));
    affectedFolderIds.add(targetFolderId || "");

    const movedFiles = filesToMove.map((file) => ({
      ...file,
      folderId: targetFolderId,
      updatedAt: timestamp,
    }));

    // Reindex each touched folder separately so moving a batch out of one
    // folder never rewrites unrelated siblings into the destination folder.
    const nextAffectedFiles = Array.from(affectedFolderIds).flatMap((groupId) => {
      const normalizedGroupId = groupId || undefined;
      const remaining = sortFilesByOrder(files.value.filter((file) => (file.folderId || "") === groupId && !moveIdSet.has(file.id)));
      const group = groupId === (targetFolderId || "") ? [...remaining, ...movedFiles] : remaining;
      return reindexFiles(group, normalizedGroupId).map((file) => ({
        ...file,
        updatedAt: timestamp,
      }));
    });
    const untouched = files.value.filter((file) => !affectedFolderIds.has(file.folderId || "") && !moveIdSet.has(file.id));

    await persistFiles([...untouched, ...nextAffectedFiles]);
  }

  async function reorderFiles(draggedId: string, targetId: string, position: "before" | "after") {
    const dragged = files.value.find((file) => file.id === draggedId);
    const target = files.value.find((file) => file.id === targetId);
    if (!dragged || !target || dragged.id === target.id) return;

    const targetFolderId = target.folderId || undefined;
    const groupFiles = sortFilesByOrder(files.value.filter((file) => (file.folderId || "") === (targetFolderId || "")));
    const remainingGroup = groupFiles.filter((file) => file.id !== draggedId);
    const draggedNext: SavedSqlFile = {
      ...dragged,
      folderId: targetFolderId,
      updatedAt: nowIso(),
    };
    const targetIndex = remainingGroup.findIndex((file) => file.id === targetId);
    const insertIndex = position === "before" ? targetIndex : targetIndex + 1;
    remainingGroup.splice(insertIndex, 0, draggedNext);

    const updatedGroup = reindexFiles(remainingGroup, targetFolderId).map((file) => ({
      ...file,
      updatedAt: draggedNext.updatedAt,
    }));

    const previousGroupId = dragged.folderId || undefined;
    const sourceGroup = previousGroupId === targetFolderId ? [] : reindexFiles(sortFilesByOrder(files.value.filter((file) => file.id !== draggedId && (file.folderId || "") === (previousGroupId || ""))), previousGroupId).map((file) => ({ ...file, updatedAt: draggedNext.updatedAt }));

    const untouched = files.value.filter((file) => file.id !== draggedId && (file.folderId || "") !== (targetFolderId || "") && (file.folderId || "") !== (previousGroupId || ""));

    await persistFiles([...untouched, ...sourceGroup, ...updatedGroup]);
  }

  const allFolders = computed(() => sortFoldersByOrder(folders.value));

  const allFoldersTreeOrder = computed(() =>
    [...folders.value].sort((a, b) => {
      const depthDiff = folderDepth(folders.value, a.id) - folderDepth(folders.value, b.id);
      if (depthDiff !== 0) return depthDiff;
      const orderDiff = (a.orderIndex ?? 0) - (b.orderIndex ?? 0);
      if (orderDiff !== 0) return orderDiff;
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
    }),
  );

  const allFiles = computed(() => sortFilesByOrder(files.value));

  function filesInFolder(folderId: string) {
    return allFiles.value.filter((f) => f.folderId === folderId);
  }

  function filesWithoutFolder() {
    return allFiles.value.filter((f) => !f.folderId);
  }

  return {
    folders,
    files,
    isLoaded,
    version,
    treeVersion,
    initFromStorage,
    listFolders,
    listChildFolders,
    listFiles,
    getFile,
    ensureFileContent,
    createFolder,
    renameFolder,
    deleteFolder,
    saveFile,
    updateFileExecutionTarget,
    renameFile,
    copyFilesToDatabase,
    recordFileUsage,
    deleteFile,
    reorderFolders,
    moveFolderToFolder,
    reorderFiles,
    moveFileToFolder,
    moveFilesToFolder,
    syncToLocalDirectory,
    refreshConnectionDir,
    reconcileFileBackedDirectories,
    pasteFilesIntoDatabase,
    isFileBacked,
    resolveConnectionSavedSqlDir,
    allFolders,
    allFoldersTreeOrder,
    allFiles,
    filesInFolder,
    filesWithoutFolder,
  };
});
