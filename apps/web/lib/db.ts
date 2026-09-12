// Shared IndexedDB opener for the web client's local DB (§14 "Client local DB":
// cached catalog, trusted nodes, sync state). Every store lives in one database
// so an upgrade is atomic and callers share one version.
//
// Why IndexedDB rather than localStorage: the catalog and transfer queue are
// structured and can grow past localStorage's practical limits, and object
// stores give us transactional read-modify-write (needed to allocate a device's
// origin_sequence without losing increments across concurrent calls).

export const WEB_DB_NAME = "nodus-web";

/**
 * Bump whenever a store is added/changed. v1 shipped only `trusted_nodes`;
 * v2 adds the catalog, sync-state, path-cache, transfer-queue, and key stores.
 */
export const WEB_DB_VERSION = 3;

export const STORE_TRUSTED_NODES = "trusted_nodes";
export const STORE_CATALOG = "catalog";
export const STORE_FOLDERS = "folders";
export const STORE_SYNC_STATE = "sync_state";
export const STORE_PATH_CACHE = "path_cache";
export const STORE_TRANSFER_QUEUE = "transfer_queue";
export const STORE_UPLOAD_PROGRESS = "upload_progress";
export const STORE_KEYS = "keys";

export const WEB_STORES = [
  STORE_TRUSTED_NODES,
  STORE_CATALOG,
  STORE_FOLDERS,
  STORE_SYNC_STATE,
  STORE_PATH_CACHE,
  STORE_TRANSFER_QUEUE,
  STORE_UPLOAD_PROGRESS,
  STORE_KEYS,
] as const;

export type WebStore = (typeof WEB_STORES)[number];

/** Primary key per store — mirrors each record's natural identifier. */
const KEY_PATH: Record<WebStore, string> = {
  [STORE_TRUSTED_NODES]: "node_id",
  [STORE_CATALOG]: "file_id",
  [STORE_FOLDERS]: "folder_id",
  [STORE_SYNC_STATE]: "origin_id",
  [STORE_PATH_CACHE]: "node_id",
  [STORE_TRANSFER_QUEUE]: "transferId",
  [STORE_UPLOAD_PROGRESS]: "transferId",
  [STORE_KEYS]: "file_id",
};

/**
 * Open (and, on first use, create) the local DB. A single opener avoids the
 * per-module version drift that caused the old trusted-nodes layer to open at
 * version 1 with no upgrade awareness.
 */
export function openWebDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(WEB_DB_NAME, WEB_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const store of WEB_STORES) {
        if (!db.objectStoreNames.contains(store)) {
          db.createObjectStore(store, { keyPath: KEY_PATH[store] });
        }
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // Another tab is upgrading: close so it can proceed instead of blocking.
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("IndexedDB upgrade blocked by another connection"));
  });
}

function requestToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Run `fn` against one store inside a transaction and resolve with its request
 * result. `fn` must synchronously issue its request(s) (IndexedDB requirement);
 * the transaction's own completion decides when the promise settles so writes
 * are durable before callers proceed.
 */
export async function withStore<T>(
  store: WebStore,
  mode: IDBTransactionMode,
  fn: (objectStore: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openWebDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(store, mode);
      const req = fn(tx.objectStore(store));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
    });
  } finally {
    db.close();
  }
}

export function idbGet<T>(store: WebStore, key: IDBValidKey): Promise<T | undefined> {
  return withStore<T | undefined>(store, "readonly", (s) => s.get(key) as IDBRequest<T | undefined>);
}

export function idbGetAll<T>(store: WebStore): Promise<T[]> {
  return withStore<T[]>(store, "readonly", (s) => s.getAll() as IDBRequest<T[]>);
}

export function idbPut<T>(store: WebStore, value: T): Promise<IDBValidKey> {
  return withStore<IDBValidKey>(store, "readwrite", (s) => s.put(value));
}

export function idbDelete(store: WebStore, key: IDBValidKey): Promise<undefined> {
  return withStore<undefined>(store, "readwrite", (s) => s.delete(key));
}

export function idbClear(store: WebStore): Promise<undefined> {
  return withStore<undefined>(store, "readwrite", (s) => s.clear());
}

/** Resolve the underlying raw value of an IDBRequest without a wrapper store. */
export { requestToPromise };
