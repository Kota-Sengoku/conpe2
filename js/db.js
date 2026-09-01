const DB_NAME = "kakeibo-db";
const DB_VERSION = 2;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("transactions")) {
        const store = db.createObjectStore("transactions", { keyPath: "id" });
        store.createIndex("date", "date");
      }
      if (!db.objectStoreNames.contains("subscriptions")) {
        db.createObjectStore("subscriptions", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("categoryRules")) {
        db.createObjectStore("categoryRules", { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

let dbPromise = null;
function getDb() {
  if (!dbPromise) dbPromise = openDb();
  return dbPromise;
}

async function tx(storeName, mode) {
  const db = await getDb();
  return db.transaction(storeName, mode).objectStore(storeName);
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export const store = {
  async getAll(storeName) {
    const s = await tx(storeName, "readonly");
    return reqToPromise(s.getAll());
  },
  async put(storeName, value) {
    const s = await tx(storeName, "readwrite");
    return reqToPromise(s.put(value));
  },
  async bulkPut(storeName, values) {
    const db = await getDb();
    return new Promise((resolve, reject) => {
      const t = db.transaction(storeName, "readwrite");
      const s = t.objectStore(storeName);
      values.forEach((v) => s.put(v));
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  },
  async delete(storeName, id) {
    const s = await tx(storeName, "readwrite");
    return reqToPromise(s.delete(id));
  },
  async clear(storeName) {
    const s = await tx(storeName, "readwrite");
    return reqToPromise(s.clear());
  },
};

export function newId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}
