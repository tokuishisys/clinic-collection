/**
 * API呼び出しと未送信データの送信処理（画面とService Workerの両方から使用）
 */
(function (global) {
  const cfg = () => global.APP_CONFIG || {};

  /** GAS APIを呼ぶ。通信失敗時は例外（e.network = true）を投げる */
  async function apiCall(action, data) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg().API_TIMEOUT_MS || 25000);
    let res;
    try {
      // text/plain にすることでCORSのプリフライトを回避（GASはOPTIONSに応答できないため）
      res = await fetch(cfg().API_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(Object.assign({ action }, data || {})),
        redirect: "follow",
        cache: "no-store",
        signal: controller.signal
      });
    } catch (e) {
      const err = new Error("通信できませんでした");
      err.network = true;
      throw err;
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const err = new Error("サーバー応答エラー (" + res.status + ")");
      err.network = true; // 一時的な障害として再送対象にする
      throw err;
    }
    try {
      return await res.json();
    } catch (e) {
      const err = new Error("サーバー応答を読み取れませんでした（GASのデプロイ設定を確認してください）");
      err.network = true;
      throw err;
    }
  }

  /**
   * 未送信キューを古い順に送信する。
   * 戻り値: { sent, failed, auth, networkError, remaining }
   */
  async function syncQueue() {
    const doSync = async () => {
      const result = { sent: 0, failed: 0, auth: 0, networkError: false, remaining: 0 };
      const items = (await global.AppDB.queueAll()).sort((a, b) => String(a.enteredAt).localeCompare(String(b.enteredAt)));
      const current = await global.AppDB.get("session");

      for (const item of items) {
        // 入力時のセッションを優先し、期限切れなら現在のセッションで再試行
        const tokens = [item.session, current && current.token].filter((v, i, a) => v && a.indexOf(v) === i);
        let res = null;
        try {
          for (const token of tokens) {
            res = await apiCall("registerClinicCollection", { session: token, payload: item.payload });
            if (res.code !== "AUTH") break;
          }
        } catch (e) {
          result.networkError = true;
          item.lastError = e.message;
          item.lastTriedAt = new Date().toISOString();
          await global.AppDB.queuePut(item);
          break; // 電波が無いので以降も無理。次の機会に回す
        }

        if (res && res.success) {
          await global.AppDB.queueDelete(item.requestId);
          result.sent++;
        } else {
          item.attempts = (item.attempts || 0) + 1;
          item.lastTriedAt = new Date().toISOString();
          item.lastError = res ? res.error : "不明なエラー";
          item.status = res && res.code === "AUTH" ? "auth" : "error";
          await global.AppDB.queuePut(item);
          if (item.status === "auth") result.auth++; else result.failed++;
        }
      }
      result.remaining = await global.AppDB.queueCount();
      return result;
    };

    // 画面とService Workerが同時に送らないようロック（無い環境でもサーバー側で重複は防止済み）
    if (global.navigator && global.navigator.locks) {
      return global.navigator.locks.request("clinic-sync", doSync);
    }
    return doSync();
  }

  global.AppSync = { apiCall, syncQueue };
})(self);
