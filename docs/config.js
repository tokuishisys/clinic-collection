/**
 * 設定ファイル
 * GASを「ウェブアプリ」としてデプロイした際のURL（.../exec）を設定してください。
 * ※ここを変更したら sw.js の CACHE_VERSION も上げてください。
 */
self.APP_CONFIG = {
  API_URL: "https://script.google.com/macros/s/AKfycbx3DS3kQZKKo6cJfPzJkReyIbLuCCYG6_5Is3xHZzItdsfEljP7ZpbdN-p02PkSkkoJ/exec",
  API_TIMEOUT_MS: 25000 // 電波が弱いときに待つ最大時間
};
