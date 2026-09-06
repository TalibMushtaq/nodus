// Trusted-node cache (IndexedDB) for the web client.
//
// The LAN pairing flow records which Storage Nodes this browser device has
// successfully paired with, keyed by node_id. Discovery UIs can then show
// "known nodes" without re-advertising, and re-auth can target a known host
// directly. IndexedDB (not localStorage) because a trusted-node list can grow
// past localStorage's practical limits and we want structured objects.

export interface TrustedNode {
  node_id: string;
  host: string;
  account_id: string;
  device_id: string;
  paired_at: string;
}

const DB_NAME = "nodus-web";
const DB_VERSION = 1;
const STORE = "trusted_nodes";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "node_id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** List all trusted nodes, newest-paired first. */
export async function getTrustedNodes(): Promise<TrustedNode[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const all = tx.objectStore(STORE).getAll();
    all.onsuccess = () => {
      const nodes = (all.result as TrustedNode[]).sort((a, b) =>
        b.paired_at.localeCompare(a.paired_at),
      );
      resolve(nodes);
    };
    all.onerror = () => reject(all.error);
    db.close();
  });
}

/** Record a successful pairing (idempotent by node_id). */
export async function addTrustedNode(node: TrustedNode): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(node);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}