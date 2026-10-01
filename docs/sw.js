/**
 * Service Worker
 *  - アプリ本体をキャッシュしてオフラインでも起動できるようにする
 *  - Background Sync で電波が戻ったら未送信データを自動送信（アプリを閉じていても動作）
 */
const CACHE_VERSION = "v1"; // ファイルを更新したら番号を上げる
const CACHE_NAME = "clinic-pwa-" + CACHE_VERSION;
const ASSETS = [
  "./",
  "./index.html",
  "./app.js",
  "./db.js",
  "./sync.js",
  "./config.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png"
];

importScripts("./config.js", "./db.js", "./sync.js");

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("clinic-pwa-") && k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  // GAS API（別オリジン）やPOSTはそのまま通す
  if (req.method !== "GET" || url.origin !== self.location.origin) return;

  // キャッシュ優先＋裏で更新（?token= 付きでも本体を返せるよう ignoreSearch）
  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cached = await cache.match(req, { ignoreSearch: true });
      const network = fetch(req)
        .then((res) => {
          // ?token= などのクエリを除いたURLで保存（トークンをキャッシュに残さない）
          if (res && res.ok) cache.put(url.origin + url.pathname, res.clone());
          return res;
        })
        .catch(() => null);
      if (cached) {
        event.waitUntil(network);
        return cached;
      }
      const res = await network;
      return res || (await cache.match("./index.html")) || Response.error();
    })
  );
});

self.addEventListener("sync", (event) => {
  if (event.tag !== "sync-collections") return;
  event.waitUntil(
    self.AppSync.syncQueue().then(async (r) => {
      const clients = await self.clients.matchAll({ includeUncontrolled: true });
      clients.forEach((c) => c.postMessage({ type: "sync-result", result: r }));
      // 電波不足で残った場合は失敗扱いにしてブラウザに再試行させる
      if (r.networkError && r.remaining > 0) throw new Error("retry later");
    })
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "skip-waiting") self.skipWaiting();
});
