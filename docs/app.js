/* =========================================================
 * クリニック集荷・センター管理  フロントエンド（PWA）
 * ========================================================= */

let session = null;        // { token, name }
let allData = [];
let clinicList = [];
let itemMasterList = [];
let deferredInstallPrompt = null;
let syncing = false;
let retryTimer = null;

/* ---------------- 共通ユーティリティ ---------------- */

function escapeHtml(v) {
  return String(v == null ? "" : v)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

let toastTimer = null;
function toast(msg, type) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.className = "show " + (type || "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = ""), 3500);
}

function newRequestId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return "req-" + Date.now() + "-" + Math.random().toString(36).slice(2, 10);
}

/** セッショントークンの有効期限（ms）を読む（署名検証はサーバー側） */
function tokenExp(token) {
  try {
    const b64 = token.split(".")[0].replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64 + "===".slice((b64.length + 3) % 4));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes)).exp || 0;
  } catch (e) {
    return 0;
  }
}

function formatLocal(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return "";
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* ---------------- 起動処理 ---------------- */

window.addEventListener("load", async () => {
  registerServiceWorker();
  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persist().catch(() => {}); // 端末の容量不足時にデータが消されにくくする
  }

  // マスタはキャッシュから即表示（圏外でも入力可能に）
  const cachedMasters = await AppDB.get("masters");
  if (cachedMasters) applyMasters(cachedMasters);

  // ポータルからの ?token=xxx
  const params = new URLSearchParams(location.search);
  const portalToken = params.get("token");
  if (portalToken) {
    history.replaceState(null, "", location.pathname); // URLからトークンを消す
  }

  const saved = await AppDB.get("session");
  if (portalToken) {
    document.getElementById("loginMessage").textContent = "ポータル認証中...";
    try {
      const res = await AppSync.apiCall("loginByToken", { token: portalToken });
      if (res.success) {
        await loginSuccess({ token: res.session, name: res.name });
      } else if (saved && tokenExp(saved.token) > Date.now()) {
        await loginSuccess(saved);
        toast("ポータル認証に失敗したため、前回のログインで続行します。", "warn");
      } else {
        document.getElementById("loginMessage").textContent = "自動認証失敗: " + res.error;
      }
    } catch (e) {
      if (saved && tokenExp(saved.token) > Date.now()) {
        await loginSuccess(saved);
        toast("圏外のため前回のログインで続行します。", "warn");
      } else {
        document.getElementById("loginMessage").textContent = "通信できません。電波のある場所でログインしてください。";
      }
    }
  } else if (saved && tokenExp(saved.token) > Date.now()) {
    await loginSuccess(saved);
  }

  window.addEventListener("online", () => { updateNetworkStatus(); trySync("online"); refreshMasters(); });
  window.addEventListener("offline", updateNetworkStatus);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") trySync("visible");
  });
  updateNetworkStatus();
  await updatePendingBadge();
});

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("./sw.js").catch((e) => console.warn("SW登録失敗", e));
  navigator.serviceWorker.addEventListener("message", async (ev) => {
    if (ev.data && ev.data.type === "sync-result") {
      const r = ev.data.result;
      if (r.sent > 0) toast(`未送信データ ${r.sent}件を自動送信しました。`, "ok");
      await updatePendingBadge();
      renderQueue();
    }
  });
}

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  document.getElementById("installBtn").classList.remove("hidden");
});
window.installApp = async function () {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  document.getElementById("installBtn").classList.add("hidden");
};

/* ---------------- ログイン ---------------- */

async function loginSuccess(sess) {
  session = sess;
  await AppDB.set("session", sess);
  document.getElementById("displayStaffName").textContent = "ログイン中: " + sess.name;
  document.getElementById("loginOverlay").style.display = "none";
  document.getElementById("mainApp").classList.remove("hidden");
  refreshMasters();
  trySync("login");
}

window.handleLogin = async function () {
  const id = document.getElementById("loginId").value.trim();
  const pass = document.getElementById("loginPass").value;
  if (!id || !pass) {
    alert("IDとパスワードを入力してください。");
    return;
  }
  const btn = document.getElementById("loginBtn");
  btn.disabled = true;
  btn.textContent = "ログイン中...";
  try {
    const res = await AppSync.apiCall("loginStaff", { id, password: pass });
    if (res.success) {
      await loginSuccess({ token: res.session, name: res.name });
    } else {
      alert(res.error);
    }
  } catch (e) {
    alert("通信できませんでした。電波のある場所でログインしてください。");
  } finally {
    btn.disabled = false;
    btn.textContent = "ログイン";
  }
};

window.logout = async function () {
  const pending = await AppDB.queueCount();
  if (pending > 0 && !confirm(`未送信データが ${pending}件あります。\nログアウトしても端末に残り、電波が戻れば送信されます。ログアウトしますか？`)) {
    return;
  }
  session = null;
  await AppDB.del("session");
  document.getElementById("loginId").value = "";
  document.getElementById("loginPass").value = "";
  document.getElementById("loginMessage").textContent = "スタッフIDとパスワードを入力してください。";
  document.getElementById("mainApp").classList.add("hidden");
  document.getElementById("loginOverlay").style.display = "flex";
};

function handleAuthError(res) {
  if (res && res.code === "AUTH") {
    alert(res.error);
    logout();
    return true;
  }
  return false;
}

/* ---------------- マスタ ---------------- */

async function refreshMasters() {
  if (!session || !navigator.onLine) return;
  try {
    const res = await AppSync.apiCall("getMasters", { session: session.token });
    if (res.success) {
      const masters = { clinics: res.clinics || [], items: res.items || [], updatedAt: new Date().toISOString() };
      await AppDB.set("masters", masters);
      applyMasters(masters);
    } else {
      handleAuthError(res);
    }
  } catch (e) {
    /* 圏外：キャッシュのまま */
  }
}

function applyMasters(masters) {
  // 入力途中の数量は保持して再描画
  const currentCounts = {};
  document.querySelectorAll(".item-count").forEach((i) => (currentCounts[i.dataset.name] = i.value));
  const currentClinic = document.getElementById("clinicName").value;

  clinicList = (masters.clinics || []).map((c) => Object.assign({}, c));
  itemMasterList = masters.items || [];
  renderClinicSelect(clinicList);
  if (currentClinic) document.getElementById("clinicName").value = currentClinic;
  renderItemList(currentCounts);
}

function renderClinicSelect(clinics) {
  const select = document.getElementById("clinicName");
  select.innerHTML = "";
  if (clinics.length === 0) {
    select.innerHTML = '<option value="">配送先データがありません</option>';
    return;
  }
  clinics.forEach((c) => {
    const opt = document.createElement("option");
    opt.value = c.name;
    opt.textContent = c.name + (c.distance != null && c.distance !== Infinity ? ` (約 ${c.distance.toFixed(1)}km)` : "");
    select.appendChild(opt);
  });
}

function renderItemList(keepCounts) {
  const div = document.getElementById("itemList");
  const openStates = {};
  div.querySelectorAll("details").forEach((d) => (openStates[d.dataset.category] = d.open));
  div.innerHTML = "";
  if (!itemMasterList || itemMasterList.length === 0) {
    div.innerHTML = '<p style="color:#666; font-size:13px;">集荷物マスタを読み込めていません。電波のある場所で一度開いてください。</p>';
    return;
  }
  itemMasterList.forEach((group) => {
    if (!group.category || !group.items) return;
    const details = document.createElement("details");
    details.className = "accordion-group";
    details.dataset.category = group.category;
    details.open = !!openStates[group.category]; // 初期状態はすべて閉じる

    const summary = document.createElement("summary");
    summary.className = "accordion-summary";
    summary.textContent = `▼ ${group.category} （品目数: ${group.items.length}）`;
    details.appendChild(summary);

    const content = document.createElement("div");
    content.className = "accordion-content";
    group.items.forEach((itemName) => {
      const row = document.createElement("div");
      row.className = "item-row";
      const label = document.createElement("label");
      label.textContent = itemName;
      const input = document.createElement("input");
      input.type = "number";
      input.className = "item-count";
      input.dataset.name = itemName;
      input.min = "0";
      input.inputMode = "numeric";
      input.value = (keepCounts && keepCounts[itemName]) || "0";
      input.onfocus = () => input.select();
      input.oninput = () => row.classList.toggle("has-count", (parseInt(input.value, 10) || 0) > 0);
      row.classList.toggle("has-count", (parseInt(input.value, 10) || 0) > 0);
      row.appendChild(label);
      row.appendChild(input);
      content.appendChild(row);
    });
    details.appendChild(content);
    div.appendChild(details);
  });
}

/* ---------------- GPS ---------------- */

/** 圏外でもGPS自体は使えます（衛星測位）。取得できなくても登録は止めません。 */
function getGPS() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve({ text: "非対応", lat: null, lng: null });
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({
        text: `${pos.coords.latitude.toFixed(5)}, ${pos.coords.longitude.toFixed(5)}`,
        lat: pos.coords.latitude,
        lng: pos.coords.longitude
      }),
      (err) => resolve({ text: "取得失敗/拒否", lat: null, lng: null, error: err.message }),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 }
    );
  });
}

/** 2点間の距離（km） */
function distanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

window.selectNearestClinic = async function () {
  if (clinicList.length === 0) {
    alert("クリニックデータが読み込まれていません。");
    return;
  }
  const status = document.getElementById("gpsStatus");
  status.textContent = "現在地を取得中...";
  const gps = await getGPS();
  if (gps.lat === null) {
    status.textContent = "";
    alert("GPSの取得に失敗しました: " + (gps.error || gps.text));
    return;
  }
  status.textContent = "";
  clinicList.forEach((c) => {
    c.distance = c.lat !== null && c.lng !== null ? distanceKm(gps.lat, gps.lng, c.lat, c.lng) : Infinity;
  });
  clinicList.sort((a, b) => a.distance - b.distance);
  renderClinicSelect(clinicList);
  document.getElementById("clinicName").selectedIndex = 0;
  toast(`一番近い「${clinicList[0].name}」を選択しました。`);
};

/* ---------------- 集荷登録（端末保存 → 送信） ---------------- */

window.submitClinicCollection = async function () {
  if (!session) return;
  const clinicName = document.getElementById("clinicName").value;
  if (!clinicName) {
    alert("クリニック名を選択してください。");
    return;
  }

  const items = [];
  document.querySelectorAll(".item-count").forEach((input) => {
    const count = parseInt(input.value, 10) || 0;
    if (count > 0) items.push({ itemName: input.dataset.name, count });
  });
  if (items.length === 0) {
    alert("1つ以上の数量を入力してください。");
    return;
  }

  const btn = document.getElementById("submitBtn");
  btn.disabled = true;
  btn.textContent = "位置情報を取得中...";

  const enteredAt = new Date().toISOString(); // ボタンを押した時刻を「日時」として記録
  const gps = await getGPS();

  const requestId = newRequestId();
  const queueItem = {
    requestId,
    enteredAt,
    staffName: session.name,
    session: session.token,
    status: "pending",
    attempts: 0,
    payload: {
      requestId,
      enteredAt,
      clinicName,
      gps: gps.text,
      items,
      remarks: document.getElementById("remarks").value
    }
  };

  try {
    // ① まず端末に保存（ここで消えなくなる）
    await AppDB.queuePut(queueItem);
  } catch (e) {
    alert("端末への保存に失敗しました: " + e.message);
    btn.disabled = false;
    btn.textContent = "集荷データを登録する";
    return;
  }

  // 入力欄をリセット
  document.querySelectorAll(".item-count").forEach((input) => {
    input.value = "0";
    input.closest(".item-row").classList.remove("has-count");
  });
  document.getElementById("remarks").value = "";
  btn.disabled = false;
  btn.textContent = "集荷データを登録する";

  // ② 電波が戻ったら自動送信されるよう Background Sync を登録
  await registerBackgroundSync();

  // ③ すぐ送信を試す
  const r = await trySync("submit");
  const stillQueued = (await AppDB.queueAll()).some((q) => q.requestId === requestId);
  if (!stillQueued) {
    toast(`${items.length}件の集荷データを登録しました。`, "ok");
  } else if (r && r.auth) {
    toast("保存しました。ログインの期限切れのため送信できません。再ログインしてください。", "err");
  } else {
    toast("電波が弱いため端末に保存しました。電波が戻ると自動で送信されます。", "warn");
  }
  await updatePendingBadge();
};

async function registerBackgroundSync() {
  try {
    const reg = await navigator.serviceWorker.ready;
    if (reg.sync) await reg.sync.register("sync-collections");
  } catch (e) {
    /* 非対応端末は画面側の再試行で送信 */
  }
}

/** 未送信データの送信を試みる（多重実行防止） */
async function trySync(reason) {
  if (syncing) return null;
  const count = await AppDB.queueCount();
  if (count === 0) return null;
  syncing = true;
  try {
    const r = await AppSync.syncQueue();
    if (reason !== "submit" && r.sent > 0) toast(`未送信データ ${r.sent}件を送信しました。`, "ok");
    if (r.remaining > 0) {
      await registerBackgroundSync();
      scheduleRetry();
    }
    return r;
  } catch (e) {
    scheduleRetry();
    return null;
  } finally {
    syncing = false;
    await updatePendingBadge();
    renderQueue();
  }
}

/** 画面を開いている間は1分ごとに再試行 */
function scheduleRetry() {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => trySync("timer"), 60000);
}

window.manualSync = async function () {
  const count = await AppDB.queueCount();
  if (count === 0) {
    toast("未送信データはありません。");
    return;
  }
  toast("送信中...");
  const r = await trySync("manual");
  if (r && r.remaining > 0) {
    toast(r.networkError ? "通信できませんでした。電波のある場所で再度お試しください。" : `${r.remaining}件が送信できませんでした。内容を確認してください。`, "err");
  }
};

window.deleteQueueItem = async function (requestId) {
  if (!confirm("この未送信データを削除しますか？\n削除するとスプレッドシートには登録されません。")) return;
  await AppDB.queueDelete(requestId);
  await updatePendingBadge();
  renderQueue();
};

async function renderQueue() {
  const list = document.getElementById("queueList");
  if (!list) return;
  const items = (await AppDB.queueAll()).sort((a, b) => String(a.enteredAt).localeCompare(String(b.enteredAt)));
  if (items.length === 0) {
    list.innerHTML = '<p style="color:#666; font-size:13px;">未送信データはありません。すべてスプレッドシートに登録済みです。</p>';
    return;
  }
  list.innerHTML = items.map((q) => {
    const p = q.payload;
    const lines = p.items.map((i) => `${escapeHtml(i.itemName)} × ${escapeHtml(i.count)}`).join("、");
    const err = q.status === "auth"
      ? "ログインの期限切れです。再ログインすると送信されます。"
      : q.lastError ? `前回の送信: ${q.lastError}` : "";
    return `
      <div class="queue-item ${escapeHtml(q.status)}">
        <div class="q-head">
          <span>${escapeHtml(p.clinicName)}</span>
          <span style="color:#666; font-weight:normal;">${escapeHtml(formatLocal(q.enteredAt))}</span>
        </div>
        <div>${lines}</div>
        ${p.remarks ? `<div style="color:#666;">備考: ${escapeHtml(p.remarks)}</div>` : ""}
        <div style="color:#666;">担当: ${escapeHtml(q.staffName)}</div>
        ${err ? `<div class="q-err">${escapeHtml(err)}</div>` : ""}
        <div style="text-align:right; margin-top:6px;">
          <button class="btn btn-small btn-danger" onclick="deleteQueueItem('${escapeHtml(q.requestId)}')">削除</button>
        </div>
      </div>`;
  }).join("");
}

async function updatePendingBadge() {
  const n = await AppDB.queueCount();
  const badge = document.getElementById("pendingBadge");
  badge.textContent = `未送信 ${n}件`;
  badge.classList.toggle("zero", n === 0);
}

function updateNetworkStatus() {
  const bar = document.getElementById("statusBar");
  const text = document.getElementById("statusText");
  if (navigator.onLine) {
    bar.className = "status-bar online no-print";
    text.textContent = "オンライン";
  } else {
    bar.className = "status-bar offline no-print";
    text.textContent = "圏外：入力は端末に保存されます";
  }
}

/* ---------------- タブ ---------------- */

window.switchTab = function (tabName) {
  ["clinic", "center", "queue"].forEach((t) => document.getElementById("tab-" + t).classList.toggle("hidden", t !== tabName));
  document.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === tabName));
  if (tabName === "center") loadData();
  if (tabName === "queue") renderQueue();
};

/* ---------------- センター受付・一覧（要オンライン） ---------------- */

window.loadData = async function () {
  const tbody = document.querySelector("#dataTable tbody");
  tbody.innerHTML = '<tr><td colspan="12" style="text-align:center; color:#666;">読み込み中...</td></tr>';
  try {
    const res = await AppSync.apiCall("getData", { session: session.token });
    if (!res.success) {
      if (!handleAuthError(res)) tbody.innerHTML = `<tr><td colspan="12" style="color:#c0392b;">${escapeHtml(res.error)}</td></tr>`;
      return;
    }
    allData = res.data || [];
    filterData();
  } catch (e) {
    tbody.innerHTML = '<tr><td colspan="12" style="text-align:center; color:#c0392b;">通信できません。電波のある場所で「データを更新」を押してください。</td></tr>';
  }
};

window.filterData = function () {
  const filterDate = document.getElementById("filterDate").value;
  const filterStatus = document.getElementById("filterStatus").value;
  const filterKeyword = document.getElementById("filterKeyword").value.toLowerCase();

  const filtered = allData.filter((row) => {
    if (filterDate) {
      const rowDateStr = String(row["日時"]).substring(0, 10).replace(/\//g, "-");
      if (rowDateStr !== filterDate) return false;
    }
    if (filterStatus && row["ステータス"] !== filterStatus) return false;
    if (filterKeyword) {
      const target = `${row["ID"]} ${row["クリニック名"]} ${row["品目"]} ${row["備考"]} ${row["受取確認者"]} ${row["受付確認者"]}`.toLowerCase();
      if (!target.includes(filterKeyword)) return false;
    }
    return true;
  });
  renderTable(filtered);
};

function renderTable(data) {
  const tbody = document.querySelector("#dataTable tbody");
  document.getElementById("selectAll").checked = false;
  if (data.length === 0) {
    tbody.innerHTML = '<tr><td colspan="12" style="text-align:center; color:#666;">データがありません</td></tr>';
    return;
  }
  const e = escapeHtml;
  tbody.innerHTML = data.map((row) => `
    <tr>
      <td class="no-print" style="text-align:center;"><input type="checkbox" class="row-checkbox" value="${e(row["ID"])}"></td>
      <td>${e(row["ID"])}</td>
      <td>${e(row["日時"])}</td>
      <td>${e(row["クリニック名"])}</td>
      <td>${e(row["品目"])}</td>
      <td style="text-align:right;">${e(row["数量"] || 0)}</td>
      <td style="text-align:center;">${e(row["ステータス"])}</td>
      <td>${e(row["GPS"])}</td>
      <td>${e(row["センター受付日時"])}</td>
      <td>${e(row["備考"])}</td>
      <td>${e(row["受取確認者"])}</td>
      <td>${e(row["受付確認者"])}</td>
    </tr>`).join("");
}

window.toggleSelectAll = function (master) {
  document.querySelectorAll(".row-checkbox").forEach((cb) => (cb.checked = master.checked));
};

window.batchReceiveAtCenter = async function () {
  const checked = document.querySelectorAll(".row-checkbox:checked");
  if (checked.length === 0) {
    alert("受付する項目にチェックを入れてください。");
    return;
  }
  const targetIds = Array.from(checked).map((cb) => cb.value);
  if (!confirm(`選択した ${targetIds.length} 件のデータを「センター受付済」に変更しますか？`)) return;

  try {
    const res = await AppSync.apiCall("updateCenterReceptionBatch", { session: session.token, targetIds });
    if (res.success) {
      alert(`${res.count}件を受付処理しました。`);
      loadData();
    } else if (!handleAuthError(res)) {
      alert("エラーが発生しました: " + res.error);
    }
  } catch (e) {
    alert("通信できませんでした。電波のある場所で再度お試しください。");
  }
};
