/**
 * IndexedDB ラッパー（画面とService Workerの両方から使用）
 *  - queue: 未送信の集荷データ
 *  - kv   : セッション・マスタデータのキャッシュ
 */
(function (global) {
  const DB_NAME = "clinic-collection";
  const DB_VERSION = 1;

  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("queue")) db.createObjectStore("queue", { keyPath: "requestId" });
        if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function reqP(r) {
    return new Promise((resolve, reject) => {
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }

  async function run(storeName, mode, fn) {
    const db = await openDB();
    try {
      const tx = db.transaction(storeName, mode);
      const done = new Promise((resolve, reject) => {
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
      const result = await fn(tx.objectStore(storeName));
      await done;
      return result;
    } finally {
      db.close();
    }
  }

  global.AppDB = {
    queuePut: (item) => run("queue", "readwrite", (s) => reqP(s.put(item))),
    queueAll: () => run("queue", "readonly", (s) => reqP(s.getAll())),
    queueDelete: (id) => run("queue", "readwrite", (s) => reqP(s.delete(id))),
    queueCount: () => run("queue", "readonly", (s) => reqP(s.count())),
    get: (key) => run("kv", "readonly", (s) => reqP(s.get(key))),
    set: (key, val) => run("kv", "readwrite", (s) => reqP(s.put(val, key))),
    del: (key) => run("kv", "readwrite", (s) => reqP(s.delete(key)))
  };
})(self);
