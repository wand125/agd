// agd web frontend
const $ = (id) => document.getElementById(id);
applyStaticI18n();
let sessions = [];
let detailKey = null;
let logTimer = null;
let kbdKey = localStorage.getItem("agd-kbd-key") || null;  // 選択カード(リロード後も復元)
let gridCols = 2;               // 現在のグリッド列数(hjkl移動用)
// カードの表示順(セッションkeyの配列)。並び替え結果ごと localStorage に永続化する
let cardOrder = [];
try { cardOrder = JSON.parse(localStorage.getItem("agd-card-order") || "[]"); } catch {}
function saveCardOrder() {
  // 実行中でないセッションの古いエントリが溜まりすぎたら間引く(順序は保持)
  if (cardOrder.length > 300) {
    const live = new Set(sessions.filter(s => s.running).map(s => s.key));
    cardOrder = cardOrder.filter(k => live.has(k));
  }
  localStorage.setItem("agd-card-order", JSON.stringify(cardOrder));
}
function ensureCardOrder(list) { // 新規セッションを末尾に追加
  let changed = false;
  for (const s of list) if (!cardOrder.includes(s.key)) { cardOrder.push(s.key); changed = true; }
  if (changed) saveCardOrder();
}
// ピン留め(セッション単位・ピン順で先頭寄せ・永続化)
let pinned = [];
try { pinned = JSON.parse(localStorage.getItem("agd-pinned-keys") || "[]"); } catch {}
function savePinned() { localStorage.setItem("agd-pinned-keys", JSON.stringify(pinned)); }
function togglePin(key) {
  if (!key) return;
  const s = sessionOf(key);
  const label = s ? maskText(s.name) : key;
  const i = pinned.indexOf(key);
  if (i >= 0) { pinned.splice(i, 1); toast(t("toast.unpinned", { name: label })); }
  else { pinned.push(key); toast(t("toast.pinned", { name: label })); }
  savePinned();
  followSelection();
  render();
}
// カードを見た目の順序で移動(delta: ±1=左右, ±列数=上下)。対象位置のカードと入れ替える
function moveCard(key, delta) {
  const list = orderedFiltered();
  const idx = list.findIndex(s => s.key === key);
  if (idx < 0) { toast(t("toast.noCardSelected")); return; }
  const vertical = Math.abs(delta) > 1;
  const dirLabel = vertical ? (delta < 0 ? t("dir.up") : t("dir.down")) : (delta < 0 ? t("dir.prev") : t("dir.next"));
  const cur = list[idx], nb = list[idx + delta];
  if (!nb) { toast(delta < 0 ? t("toast.atStart") : t("toast.atEnd")); return; }
  const curPinned = pinned.includes(cur.key), nbPinned = pinned.includes(nb.key);
  if (curPinned && nbPinned) {
    // ピン同士 → ピン順を入れ替え
    const i = pinned.indexOf(cur.key), j = pinned.indexOf(nb.key);
    [pinned[i], pinned[j]] = [pinned[j], pinned[i]];
    savePinned();
    toast(t("toast.movedTo", { dir: dirLabel }));
  } else if (curPinned !== nbPinned) {
    toast(t("toast.pinBoundary"));
  } else {
    const a = cardOrder.indexOf(cur.key), b = cardOrder.indexOf(nb.key);
    if (a >= 0 && b >= 0) { [cardOrder[a], cardOrder[b]] = [cardOrder[b], cardOrder[a]]; saveCardOrder(); }
    toast(t("toast.cardMovedTo", { dir: dirLabel }));
  }
  followSelection();
  render();
}
// 選択中カードが表示されるページへ移動(ピン操作でカードがページを跨いだとき用)
function followSelection() {
  if (!kbdKey) return;
  const list = orderedFiltered();
  const idx = list.findIndex(s => s.key === kbdKey);
  if (idx < 0) return;
  page = Math.floor(idx / Number($("per-page").value));
}
let page = Number(localStorage.getItem("agd-page")) || 0;  // 表示ページ(リロード後も復元)
let activeTab = localStorage.getItem("agd-tab") || "grid";   // grid | list | split
const screenScrolled = new Set(); // 手動スクロール中(自動追従を止める)カードのkey
const filters = { waiting: true, busy: true, idle: true, claude: true, codex: true };
const PER_PAGE_LAYOUT = { 1: [1, 1], 2: [2, 1], 4: [2, 2], 6: [3, 2], 9: [3, 3], 12: [4, 3] };

// ---------------- ユーティリティ ----------------
let pathStrip = "";  // AGD_PATH_STRIP で指定された共通プレフィックスを「…」に短縮
function shortCwd(c) {
  let s = c || "";
  if (pathStrip && s.startsWith(pathStrip)) s = "…" + s.slice(pathStrip.length);
  return maskText(s.replace(/^\/Users\/[^/]+/, "~").replace(/^\/home\/[^/]+/, "~"));
}
// ---------------- マスクモード(スクリーンショット用) ----------------
// 決定的スクランブル: 英字→英字・数字→数字・CJK→ダミー漢字。空白/記号/罫線は保持するので
// レイアウトと ANSI カラーはそのまま、内容だけが読めなくなる。:mask で切替
function toggleMask() {
  maskMode = !maskMode;
  localStorage.setItem("agd-mask", maskMode ? "1" : "0");
  document.querySelectorAll(".screen").forEach(el => delete el.dataset.raw);  // 画面キャッシュ無効化
  render();
  if (detailKey) renderLog(false);
  toast(maskMode ? t("toast.maskOn") : t("toast.maskOff"));
}
// エスケープ済みテキスト内の URL をリンク化(新しいタブで開く)。末尾の句読点や括弧は除外
function linkify(escaped) {
  // 日本語(かな・漢字・全角記号)はURL境界とみなして打ち切る
  return escaped.replace(/(https?:\/\/[^\s<>"'\u3000-\u30ff\u4e00-\u9fff\uff00-\uffef]+)/g, (m) => {
    // 末尾の句読点・括弧・Markdown記号(** など)はURLに含めない
    const url = m.replace(/[)\]}.,;:\u3002\u3001\u300d\u300f>*_`]+$/, "");
    return `<a href="${url}" target="_blank" rel="noopener">${url}</a>${m.slice(url.length)}`;
  });
}
function projName(cwd) {
  const parts = (cwd || "").split("/").filter(Boolean);
  return maskText(parts[parts.length - 1] || cwd);
}
function projColor(cwd) {
  let h = 0;
  const name = projName(cwd);
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return `hsl(${h}, 55%, 62%)`;
}
// ---------------- ANSI カラー → HTML ----------------
function setScreen(el, raw) {
  if (el.dataset.raw === raw) return false;
  el.dataset.raw = raw;
  el.innerHTML = ansiToHtml(raw);
  return true;
}

async function api(path, body) {
  const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return r.json();
}
let toastTimer = null;
function toast(msg) {
  document.querySelectorAll(".toast").forEach(t => t.remove());
  const t = document.createElement('div');
  t.className = "toast"; t.textContent = msg;
  document.body.appendChild(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), 2500);
}
function sessionOf(key) { return sessions.find(x => x.key === key); }

// ---------------- WebSocket ----------------
// スマホ幅で PC 版を開いたら /m を提案する。閉じたら記憶して二度と出さない
(function suggestMobile() {
  const el = $("mobile-banner");
  if (!el) return;
  // 閉じるハンドラは表示条件に関わらず必ず張る(条件付きで登録すると閉じられなくなる)
  $("banner-x").onclick = () => {
    el.classList.remove("on");
    localStorage.setItem("agd-no-mobile-banner", "1");
  };
  if (localStorage.getItem("agd-no-mobile-banner") === "1") return;
  // 実機の画面幅かタッチ操作なら PC 版は窮屈なので /m を提案する
  const narrow = Math.min(screen.width, innerWidth) <= 700;
  if (narrow || matchMedia("(pointer: coarse)").matches) el.classList.add("on");
})();

let assetVersion = null;   // サーバーが配る app.js/i18n.js/index.html の版
function connect() {
  const ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === "snapshot") {
      // フロント資産が更新されたら自動で読み直す。agd.app(WKWebView)は
      // 手動リロード手段が限られ、古い JS のまま動き続けると原因が掴みにくい
      if (msg.assetVersion) {
        if (!assetVersion) assetVersion = msg.assetVersion;
        else if (assetVersion !== msg.assetVersion) { location.reload(); return; }
      }
      sessions = msg.sessions || [];
      render();
      (msg.changes || []).forEach(handleChange);
    }
  };
  ws.onclose = () => { $("stats").textContent = t("stats.disconnected"); setTimeout(connect, 2000); };
}
connect();

// ---------------- タブ ----------------
function setTab(tab) {
  activeTab = tab;
  localStorage.setItem("agd-tab", tab);
  const split = tab === "split";
  for (const [id, on] of [["tab-grid", tab === "grid"], ["tab-list", tab === "list"], ["tab-split", split]])
    $(id).classList.toggle("on", on);
  // 並列では両方を出す。単独表示のときの見た目は従来どおり
  $("views").classList.toggle("split", split);
  // 右ペインは「1枚の画面+ログ」の詳細。既存のモーダルを流用する
  document.body.classList.toggle("split-detail", split);
  if (split) { updateSplitTop(); setSplitPane("list"); openSplitDetail(listKey ?? kbdKey); }
  else if (splitDetailOpen) { splitDetailOpen = false; closeDetail(); }
  $("grid-view").style.display = tab === "list" ? "none" : "";
  $("list-view").style.display = tab === "grid" ? "none" : "block";
  $("pager").style.display = tab === "list" ? "none" : "";
  render();
}
$("tab-grid").onclick = () => setTab("grid");
$("tab-list").onclick = () => setTab("list");
$("tab-split").onclick = () => setTab("split");

// ---------------- 通知 ----------------
$("notify-toggle").checked = localStorage.getItem("agd-notify") === "1";
$("notify-toggle").onchange = async (e) => {
  if (e.target.checked && Notification.permission !== "granted") {
    const p = await Notification.requestPermission();
    if (p !== "granted") { e.target.checked = false; return; }
  }
  localStorage.setItem("agd-notify", e.target.checked ? "1" : "0");
};
fetch("/api/config").then(r => r.json()).then(c => {
  $("mac-notify-toggle").checked = !!c.macNotify;
  pathStrip = c.pathStrip || "";
  render();
});
$("mac-notify-toggle").onchange = (e) => api("/api/config", { macNotify: e.target.checked });
function handleChange(c) {
  if (!$("notify-toggle").checked) return;
  if (c.from === "busy" && (c.to === "waiting" || c.to === "idle")) {
    const label = c.to === "waiting" ? t("notify.waiting") : t("notify.done");
    const n = new Notification(`${c.name} — ${label}`, { body: `${c.agent} / ${label}`, tag: c.key });
    n.onclick = () => { window.focus(); if (c.tty) api("/api/focus", { tty: c.tty }); };
  }
}

// ---------------- フィルタ・ページャ ----------------
document.querySelectorAll(".chip").forEach(chip => {
  chip.onclick = () => {
    filters[chip.dataset.filter] = !filters[chip.dataset.filter];
    chip.classList.toggle("on", filters[chip.dataset.filter]);
    page = 0; render();
  };
});
$("search").oninput = () => { page = 0; render(); };
$("search").onkeydown = (e) => {
  e.stopPropagation();
  if (e.isComposing || e.keyCode === 229) return;  // IME変換中は無視
  if (e.key === "Enter" && $("search").value.trim().length >= 2) runSearch($("search").value.trim());
  if (e.key === "Escape") { $("search").value = ""; $("search").blur(); render(); }
};
$("per-page").value = localStorage.getItem("agd-per-page") || "4";
$("per-page").onchange = () => { localStorage.setItem("agd-per-page", $("per-page").value); page = 0; render(); };
$("sort-mode").value = localStorage.getItem("agd-sort-mode") || "stable";
$("sort-mode").onchange = () => { localStorage.setItem("agd-sort-mode", $("sort-mode").value); page = 0; render(); };
function flashBar(id) {
  const b = $(id);
  b.classList.add("flash");
  setTimeout(() => b.classList.remove("flash"), 250);
}
$("page-prev").onclick = () => { if (page > 0) flashBar("bar-prev"); page = Math.max(0, page - 1); render(); };
$("page-next").onclick = () => { flashBar("bar-next"); page = page + 1; render(); };
$("bar-prev").onclick = () => $("page-prev").click();
$("bar-next").onclick = () => $("page-next").click();

function visibleRunning() {
  const q = $("search").value.trim().toLowerCase();
  return sessions.filter(s => s.running)
    .filter(s => filters[s.status] !== false && filters[s.agent] !== false)
    .filter(s => !q || s.name.toLowerCase().includes(q) || s.cwd.toLowerCase().includes(q) ||
                 (s.git?.branch ?? "").toLowerCase().includes(q));
}

// ---------------- 描画 ----------------
function render() {
  const all = sessions.filter(s => s.running);
  ensureCardOrder(all);
  // 終了要求中のセッションが一覧から消えたらクリーンアップ
  for (const k of closing) if (!all.some(s => s.key === k)) closing.delete(k);
  // 複製/新規起動後の新カード出現を待ち受けて選択を移す
  if (pendingSelect) {
    if (Date.now() > pendingSelect.until) pendingSelect = null;
    else {
      const hit = all.find(s => s.agent === pendingSelect.agent && s.cwd === pendingSelect.cwd && !pendingSelect.keys.has(s.key));
      if (hit) {
        kbdKey = hit.key;
        pendingSelect = null;
        followSelection();
        toast(t("toast.selectionMoved"));
      }
    }
  }
  const counts = { waiting: 0, busy: 0, idle: 0 };
  all.forEach(s => counts[s.status] = (counts[s.status] ?? 0) + 1);
  $("stats").textContent = t("stats.counts", counts);
  $("tab-grid-badge").textContent = counts.waiting ? `▲${counts.waiting}` : "";
  document.title = (counts.waiting ? `(${counts.waiting}) ` : "") + "agd — Agent Dashboard";
  // 並列表示では両方を描く。単独表示のときは見えている側だけ
  if (activeTab !== "list") renderGrid();
  if (activeTab !== "grid") renderList();
}

// 表示順を確定(固定順/状態順 → ピン留めを先頭へ)。renderGrid と followSelection で共用
function orderedFiltered() {
  let filtered = visibleRunning();
  if (($("sort-mode")?.value ?? "stable") === "stable") {
    const rank = new Map(cardOrder.map((k, i) => [k, i]));
    filtered = [...filtered].sort((a, b) => (rank.get(a.key) ?? 1e9) - (rank.get(b.key) ?? 1e9));
  }
  const pinRank = (s) => { const i = pinned.indexOf(s.key); return i < 0 ? 1e9 : i; };
  return [...filtered].sort((a, b) => pinRank(a) - pinRank(b));
}

function renderGrid() {
  const filtered = orderedFiltered();
  const perPage = Number($("per-page").value);
  const pages = Math.max(1, Math.ceil(filtered.length / perPage));
  page = Math.min(page, pages - 1);
  localStorage.setItem("agd-page", String(page));
  $("page-info").textContent = `${page + 1}/${pages}`;
  $("page-prev").disabled = page === 0;
  $("page-next").disabled = page >= pages - 1;
  $("bar-prev").classList.toggle("off", page === 0);
  $("bar-next").classList.toggle("off", page >= pages - 1);
  const shown = filtered.slice(page * perPage, (page + 1) * perPage);

  // レイアウト(スクロールなし・固定グリッド)
  const [cols, rows] = PER_PAGE_LAYOUT[perPage] ?? [2, 2];
  const grid = $("grid");
  gridCols = Math.min(cols, Math.max(1, shown.length));
  grid.style.gridTemplateColumns = `repeat(${gridCols}, 1fr)`;
  grid.style.gridTemplateRows = `repeat(${shown.length > cols ? rows : 1}, 1fr)`;

  const existing = new Map([...grid.children].map(el => [el.dataset.key, el]));
  const seen = new Set();
  shown.forEach((s, i) => {
    seen.add(s.key);
    let el = existing.get(s.key);
    if (!el) {
      el = buildCard(s.key);
      grid.appendChild(el);
    }
    el.className = `card status-${s.status}${closing.has(s.key) ? " closing" : ""}`;
    el.style.order = i;
    el.style.borderLeftColor = projColor(s.cwd);
    el.querySelector(".agent-tag").textContent = s.agent;
    const pt = el.querySelector(".proj-tag");
    pt.textContent = projName(s.cwd);
    pt.style.background = projColor(s.cwd);
    // 識別名(0-group-14)＋ Claude アプリの表示名(ai-title)を併記
    el.querySelector(".card-title").innerHTML =
      esc(maskText(s.name)) + (s.title ? ` <span class="ai-title">${esc(maskText(s.title))}</span>` : "");
    el.querySelector(".card-meta").textContent = fmtAge(s.ageS);
    el.querySelector(".git-badge").innerHTML = gitBadge(s.git);
    el.querySelector(".pin-btn").classList.toggle("pinned", pinned.includes(s.key));
    const sum = el.querySelector(".card-summary");
    sum.textContent = maskText(s.summary ?? "");
    sum.title = maskText(s.summary ?? "");
    sum.style.display = s.summary ? "" : "none";
    renderPromptBar(el.querySelector(".prompt-bar"), s);
    const scr = el.querySelector(".screen");
    if (setScreen(scr, s.screen ?? t("card.screenUnavailable"))) {
      if (!screenScrolled.has(s.key)) scr.scrollTop = scr.scrollHeight;
    }
    el.querySelector(".latest-btn").style.display = screenScrolled.has(s.key) ? "" : "none";
  });
  for (const [key, el] of existing) if (!seen.has(key)) el.remove();
  $("empty").style.display = filtered.length ? "none" : "";
  updateKbdSelection();
}

function buildCard(key) {
  const el = document.createElement('div');
  el.dataset.key = key;
  el.innerHTML = `
    <div class="card-head">
      <span class="dot"></span><span class="agent-tag"></span><span class="proj-tag"></span>
      <span class="card-title"></span>
      <span class="git-badge"></span><span class="card-meta"></span>
      <button class="jump-btn pin-move pin-left" title="${t("card.moveLeft")}">◀</button>
      <button class="jump-btn pin-move pin-up" title="${t("card.moveUp")}">▲</button>
      <button class="jump-btn pin-move pin-down" title="${t("card.moveDown")}">▼</button>
      <button class="jump-btn pin-move pin-right" title="${t("card.moveRight")}">▶</button>
      <button class="jump-btn pin-btn" title="${t("card.pin")}">
        <svg viewBox="0 0 24 24"><path d="M9 4h6l-1 6 4 3v2H6v-2l4-3-1-6z"/><path d="M12 15v5"/></svg>
      </button>
      <button class="jump-btn detail-btn" title="${t("card.detail")}">
        <svg viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-7 7M10 20H4v-6M4 20l7-7"/></svg>
      </button>
      <button class="jump-btn go-btn" title="${t("card.jump")}">
        <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/></svg>
      </button>
    </div>
    <div class="card-summary" style="display:none"></div>
    <div class="prompt-bar" style="display:none"></div>
    <div class="screen-wrap">
      <div class="screen"></div>
      <button class="latest-btn">${t("card.latest")}</button>
    </div>
    <div class="send-row"><textarea rows="1" placeholder="${t("card.sendPlaceholder")}"></textarea></div>`;
  el.querySelector(".pin-btn").onclick = (e) => { e.stopPropagation(); togglePin(el.dataset.key); };
  el.querySelector(".pin-left").onclick = (e) => { e.stopPropagation(); moveCard(el.dataset.key, -1); };
  el.querySelector(".pin-right").onclick = (e) => { e.stopPropagation(); moveCard(el.dataset.key, 1); };
  el.querySelector(".pin-up").onclick = (e) => { e.stopPropagation(); moveCard(el.dataset.key, -gridCols); };
  el.querySelector(".pin-down").onclick = (e) => { e.stopPropagation(); moveCard(el.dataset.key, gridCols); };
  el.querySelector(".detail-btn").onclick = (e) => { e.stopPropagation(); openDetail(el.dataset.key); };
  el.querySelector(".go-btn").onclick = (e) => { e.stopPropagation(); jump(el.dataset.key); };
  el.querySelector(".proj-tag").onclick = (e) => { e.stopPropagation(); $("search").value = projName(sessionOf(el.dataset.key)?.cwd ?? ""); page = 0; render(); };
  const input = el.querySelector(".send-row textarea");
  const send = () => sendTo(el.dataset.key, input);
  input.oninput = () => { updateSlashHints(input, () => sessionOf(el.dataset.key)); autoGrow(input, 140); };
  input.onkeydown = (e) => {
    e.stopPropagation();
    if (e.isComposing || e.keyCode === 229) return;  // IME変換中の確定Enterは無視
    if (handleHintKeys(e, input)) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();  // ⇧⏎ は改行、⏎ は送信
      if (input.value.trim()) send();
      else confirmEnter(el.dataset.key);  // 空欄で Enter → 選択中プロンプトの確定
    }
    if (e.key === "Escape") input.blur();  // 選択モードへ戻る
  };
  input.onfocus = () => { kbdKey = el.dataset.key; isInsert = true; updateKbdSelection(); };
  input.onblur = () => { isInsert = false; updateKbdSelection(); hideHints(); };
  const scr = el.querySelector(".screen");
  const latest = el.querySelector(".latest-btn");
  scr.onscroll = () => {
    const atBottom = scr.scrollHeight - scr.scrollTop - scr.clientHeight < 30;
    if (atBottom) screenScrolled.delete(el.dataset.key); else screenScrolled.add(el.dataset.key);
    latest.style.display = atBottom ? "none" : "";
  };
  latest.onclick = (e) => {
    e.stopPropagation();
    screenScrolled.delete(el.dataset.key);
    scr.scrollTop = scr.scrollHeight;
    latest.style.display = "none";
  };
  return el;
}

// 操作先の識別。ローカルは tty、リモート(ssh+tmux)は remote を持つ。
// tty が無い＝操作不能ではないので、判定は必ずこれを通す。
// API に渡す宛先。サーバー側は cardKey があれば remote を優先解決する

let listKey = null;  // セッションタブでの選択中セッションkey
let splitDetailOpen = false;   // 並列ビューで右ペインに詳細を出しているか
let splitPane = "list";        // 並列ビューでカーソルがある側: list | detail
// ヘッダーは要素数や言語で高さが変わる。右ペインの開始位置を実測で合わせる
function updateSplitTop() {
  const h = Math.round($("header").getBoundingClientRect().height);
  document.documentElement.style.setProperty("--split-top", h + "px");
}
addEventListener("resize", updateSplitTop);

function setSplitPane(p) {
  splitPane = p;
  document.body.classList.toggle("pane-detail", p === "detail");
  if (p === "detail") { detailSel = -1; updateDetailSel(); }
  else $("d-input").blur();
}
// 並列ビューの右ペインに詳細を出す(モーダルと同じ実体を使い回す)
function openSplitDetail(key) {
  const s = sessionOf(key) ? key : (visibleRunning()[0]?.key ?? null);
  document.body.classList.toggle("no-selection", !s);
  if (!s) { if (splitDetailOpen) { splitDetailOpen = false; closeDetail(); } return; }
  listKey = s;
  updateListSelection();
  splitDetailOpen = true;
  openDetail(s);
}
function updateListSelection() {
  document.querySelectorAll("#list-view .resume-row").forEach(r =>
    r.classList.toggle("kbd-selected", r.dataset.key === listKey));
}
// 並列で選択が変わったら右ペインを追従させる。同じセッションなら開き直さない
function syncSplitDetail() {
  if (activeTab !== "split" || !listKey || detailKey === listKey) return;
  splitDetailOpen = true;
  document.body.classList.remove("no-selection");
  openDetail(listKey);
}
function renderList() {
  const running = sessions.filter(s => s.running);
  const resumable = sessions.filter(s => !s.running && !archived.has(s.key));
  const rr = $("running-rows");
  rr.innerHTML = "";
  running.forEach(s => rr.appendChild(buildRow(s, true)));
  const rl = $("resumables");
  rl.innerHTML = "";
  resumable.forEach(s => rl.appendChild(buildRow(s, false)));
  updateListSelection();
}

// ---------------- スラッシュコマンドヒント(送信欄で / を打つと表示) ----------------
const INTERNAL_CMDS = [
  { cmd: "q", descKey: "cmd.q" },
  { cmd: "show", descKey: "cmd.show" },
  { cmd: "new", descKey: "cmd.new" },
  { cmd: "esc", descKey: "cmd.esc" },
  { cmd: "mode", descKey: "cmd.mode" },
  { cmd: "key ", descKey: "cmd.key" },
  { cmd: "mask", descKey: "cmd.mask" },
  { cmd: "sum", descKey: "cmd.sum" },
  { cmd: "/", descKey: "cmd.slash" },
  { cmd: "lang ", descKey: "cmd.lang" },
];
const slashCache = new Map(); // "agent|cwd" → [{cmd, desc}]
async function slashList(s) {
  const ck = `${s.agent}|${s.cwd}`;
  if (!slashCache.has(ck)) {
    try {
      const r = await fetch(`/api/slash?agent=${s.agent}&cwd=${encodeURIComponent(s.cwd)}`);
      slashCache.set(ck, (await r.json()).commands ?? []);
    } catch { slashCache.set(ck, []); }
  }
  return slashCache.get(ck);
}
let hintState = null; // { input, items, sel }
function hideHints() { $("hint-panel").style.display = "none"; hintState = null; }
function renderHints() {
  if (!hintState) return;
  const p = $("hint-panel");
  const { input, items, sel } = hintState;
  p.innerHTML = items.map((c, i) =>
    `<div class="hint-row ${i === sel ? "sel" : ""}"><span class="cmd">${esc(c.cmd)}</span><span class="desc">${esc(c.descKey ? t(c.descKey) : c.desc)}</span></div>`).join("");
  [...p.children].forEach((row, i) => {
    row.onmousedown = (ev) => {
      ev.preventDefault();
      input.value = items[i].cmd.trimEnd() + " ";
      input.dispatchEvent(new Event('input'));
      input.focus();
    };
  });
  const r = input.getBoundingClientRect();
  p.style.display = "block";
  p.style.left = r.left + "px";
  p.style.bottom = (window.innerHeight - r.top + 4) + "px";
  p.style.minWidth = Math.min(Math.max(r.width, 280), 480) + "px";
  p.querySelector(".hint-row.sel")?.scrollIntoView({ block: "nearest" });
}
// / 始まりの入力に対しエージェント別のコマンド候補を表示
async function updateSlashHints(input, getSession) {
  const v = input.value;
  if (!v.startsWith("/")) { if (hintState?.input === input) hideHints(); return; }
  const s = getSession();
  if (!s) { hideHints(); return; }
  const all = await slashList(s);
  if (input.value !== v) return;  // 取得中に入力が変わった
  const pre = v.split(" ")[0].toLowerCase();
  const items = all.filter(c => c.cmd.toLowerCase().startsWith(pre)).slice(0, 14);
  if (!items.length) { hideHints(); return; }
  const keepSel = hintState?.input === input ? Math.min(hintState.sel, items.length - 1) : 0;
  hintState = { input, items, sel: keepSel };
  renderHints();
}
// ヒント表示中のキー操作。true を返したら呼び元は処理を打ち切る
function handleHintKeys(e, input) {
  if (!hintState || hintState.input !== input) return false;
  if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "j")) { e.preventDefault(); hintState.sel = Math.min(hintState.sel + 1, hintState.items.length - 1); renderHints(); return true; }
  if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "k")) { e.preventDefault(); hintState.sel = Math.max(hintState.sel - 1, 0); renderHints(); return true; }
  if (e.key === "Tab") {
    e.preventDefault();
    input.value = hintState.items[hintState.sel].cmd.trimEnd() + " ";
    input.dispatchEvent(new Event('input'));
    return true;
  }
  if (e.key === "Enter") {
    // 引数なしならハイライト中の候補で確定してから通常のEnter処理(送信)へ
    const v = input.value.trim();
    if (v && !v.includes(" ") && hintState.items[hintState.sel]) input.value = hintState.items[hintState.sel].cmd.trim();
    hideHints();
    return false;
  }
  if (e.key === "Escape") { hideHints(); return true; }
  return false;
}

// ---------------- コマンドライン(:q など) ----------------
const closing = new Set();  // :q で終了要求中(一覧から消えるまで半透明表示)
let archived = new Set();
try { archived = new Set(JSON.parse(localStorage.getItem("agd-archived") || "[]")); } catch {}
function saveArchived() { localStorage.setItem("agd-archived", JSON.stringify([...archived])); }

// ---------------- ヘルプ ----------------
function toggleHelp() { $("help-overlay").classList.toggle("show"); }
function closeHelp() { $("help-overlay").classList.remove("show"); }
$("help-overlay").onclick = (e) => { if (e.target === $("help-overlay")) closeHelp(); };

function openCmdline() {
  $("cmdline").style.display = "flex";
  $("cmd-input").value = "";
  $("cmd-input").focus();
  $("cmd-input").dispatchEvent(new Event('input'));  // 内部コマンド一覧を最初から表示
}
function closeCmdline() {
  if ($("cmdline").style.display === "none") return;  // blur ハンドラとの再入防止
  $("cmdline").style.display = "none";
  $("cmd-input").blur();
  hideHints();
}
$("cmd-input").oninput = () => {
  const v = $("cmd-input").value;
  if (v.startsWith("/")) { updateSlashHints($("cmd-input"), () => sessionOf(curSelKey())); return; }
  // 内部コマンドのヒント(空欄なら全件)
  const items = INTERNAL_CMDS.filter(c => c.cmd.startsWith(v.trim())).slice(0, 10);
  if (!items.length) { hideHints(); return; }
  const keepSel = hintState?.input === $("cmd-input") ? Math.min(hintState.sel, items.length - 1) : 0;
  hintState = { input: $("cmd-input"), items, sel: keepSel };
  renderHints();
};
$("cmd-input").onkeydown = (e) => {
  e.stopPropagation();
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key === "Escape") { closeCmdline(); return; }  // ヒント表示中でも一発で閉じる
  if (handleHintKeys(e, $("cmd-input"))) return;
  if (e.key === "Enter") { const c = $("cmd-input").value.trim(); closeCmdline(); runCommand(c); }
};
$("cmd-input").onblur = () => closeCmdline();  // 外側クリックでも閉じる
function curSelKey() {
  // 詳細ポップアップ表示中はそのセッションをコマンドの対象にする
  if ($("overlay").classList.contains("show") && detailKey) return detailKey;
  return activeTab === "list" ? listKey : kbdKey;
}
// 選択セッションへ名前付きキーを送る(m: モード切替, s: 中断 など)
async function sendNamedKey(k, label) {
  const s = sessionOf(curSelKey());
  if (!canOperate(s)) { toast(t("toast.selectRunning")); return; }
  const r = await api("/api/key", { ...target(s), key: k });
  if ((r.result || "").startsWith("ok")) toast(t("toast.sentTo", { action: label, name: s.name }));
  else toast(t("toast.sendFailed", { err: r.result }));
}
// 選択セッションへテキスト送信(スラッシュコマンド用)
async function sendTextToSelected(text) {
  const s = sessionOf(curSelKey());
  if (!canOperate(s)) { toast(t("toast.selectRunning")); return; }
  const r = await api("/api/send", { ...target(s), text });
  if ((r.result || "").startsWith("ok")) toast(t("toast.sentTo", { action: text, name: s.name }));
  else toast(t("toast.sendFailed", { err: r.result }));
}
async function runCommand(c) {
  if (c === "q") {
    const selKey = curSelKey();
    const s = sessionOf(selKey);
    if (!s) { toast(t("toast.qNoSession")); return; }
    const viewing = detailKey === selKey && $("overlay").classList.contains("show");
    if (s.running) {
      if (!canOperate(s)) { toast(t("toast.ttyCloseUnknown")); return; }
      closing.add(s.key);
      render();
      const r = await api("/api/close", { ...target(s) });
      if ((r.result || "").startsWith("ok")) {
        toast(t("toast.closed", { name: s.name }));
        if (viewing) closeDetail();  // 表示中のセッションを終了したらポップアップも閉じる
      }
      else { closing.delete(s.key); render(); toast(t("toast.closeFailed", { err: r.result })); }
    } else {
      archived.add(s.key);
      saveArchived();
      render();
      toast(t("toast.hidden", { name: s.name }));
    }
  } else if (c === "show") {
    archived.clear();
    saveArchived();
    render();
    toast(t("toast.shown"));
  } else if (c === "new") {
    openNew();
  } else if (c === "mask") {
    toggleMask();
  } else if (c === "sum") {
    const key = curSelKey();
    if (!key) { toast(t("toast.sumNoSession")); return; }
    api("/api/summarize", { key }).then(() => toast(t("toast.summarizing")));
  } else if (c.startsWith("/")) {
    // スラッシュコマンドを選択セッションへそのまま送信(:/clear など)
    sendTextToSelected(c);
  } else if (c === "esc") {
    sendNamedKey("Escape", t("action.interrupt"));
  } else if (c === "mode") {
    sendNamedKey("ShiftTab", t("action.mode"));
  } else if (c.startsWith("key ")) {
    const k = c.slice(4).trim();
    const valid = ["Enter", "Escape", "Up", "Down", "Left", "Right", "Tab", "ShiftTab"];
    if (valid.includes(k)) sendNamedKey(k, k);
    else toast(t("toast.invalidKey", { key: k, valid: valid.join(" ") }));
  } else if (c === "lang" || c.startsWith("lang ")) {
    const next = c.slice(4).trim();
    if (next === "en" || next === "ja") {
      setLang(next);
      toast(t("toast.langChanged"));
      $("grid").replaceChildren();
      render();
      if (detailKey) {
        const s = sessionOf(detailKey);
        if (s) {
          $("d-meta").textContent = `${shortCwd(s.cwd)} · ${t(`status.${s.status}`)}`;
          setScreen($("d-screen"), s.screen ?? t("detail.screenUnavailable"));
          renderPromptBar($("d-prompt"), s);
          loadSubagents(s);
        }
        $("d-kbd-hint").innerHTML = $("d-input") === document.activeElement ? t("hint.detailInsert") : t("hint.detailScroll");
        renderLog(false);
      }
      if ($("new-overlay").classList.contains("show")) renderNewList();
    } else {
      toast(t("toast.currentLang", { lang: getLang() }));
    }
  } else if (c) {
    toast(t("toast.unknownCommand", { cmd: c }));
  }
}

let resumeBusy = false;
async function resumeSession(s) {
  if (!s || resumeBusy) return;
  resumeBusy = true;
  await api("/api/resume", { agent: s.agent, sid: s.sid, cwd: s.cwd });
  resumeBusy = false;
  toast(t("toast.resumed", { agent: s.agent }));
}

function buildRow(s, running) {
  const row = document.createElement('div');
  row.className = "resume-row" + (closing.has(s.key) ? " closing" : "");
  row.dataset.key = s.key;
  row.innerHTML = `
    <span class="dot"></span>
    <span class="agent-tag">${s.agent}</span>
    <span class="proj-tag" style="background:${projColor(s.cwd)}">${esc(projName(s.cwd))}</span>
    <span class="card-title"></span>
    <span class="row-summary"></span>
    <span class="git-badge">${running ? gitBadge(s.git) : ""}</span>
    <span class="card-meta"></span>`;
  row.querySelector(".dot").style.background = `var(--${s.status})`;
  row.querySelector(".card-title").innerHTML =
    esc(maskText(s.name)) + (s.title ? ` <span class="ai-title">${esc(maskText(s.title))}</span>` : "");
  const sum = row.querySelector(".row-summary");
  sum.textContent = s.summary ? maskText(s.summary) : "";
  sum.title = s.summary ? maskText(s.summary) : "";
  row.querySelector(".card-meta").textContent = `${shortCwd(s.cwd)} · ${t(`status.${s.status}`)} · ${fmtAge(s.ageS)}`;
  const btns = document.createElement('span');
  btns.className = "row-btns";
  if (running) {
    btns.innerHTML = `<button class="btn">${t("row.log")}</button> <button class="btn"><svg class="icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/></svg></button>`;
    const [logBtn, jumpBtn] = btns.querySelectorAll("button");
    logBtn.onclick = () => openDetail(s.key);
    jumpBtn.onclick = () => jump(s.key);
  } else {
    btns.innerHTML = `<button class="btn">${t("row.log")}</button> <button class="btn">${t("row.resume")}</button>`;
    const [logBtn, resumeBtn] = btns.querySelectorAll("button");
    logBtn.onclick = () => openDetail(s.key);
    resumeBtn.onclick = () => resumeSession(s);
  }
  row.appendChild(btns);
  row.querySelector(".card-title").onclick = () => {
    if (activeTab === "split") { listKey = s.key; updateListSelection(); syncSplitDetail(); setSplitPane("detail"); }
    else openDetail(s.key);
  };
  return row;
}

function gitBadge(g) {
  if (!g || !g.branch) return "";
  let out = `⎇ ${esc(maskText(g.branch))}`;
  if (g.dirty) out += ` <span class="dirty">●${g.dirty}</span>`;
  if (g.ahead) out += ` ↑${g.ahead}`;
  if (g.behind) out += ` ↓${g.behind}`;
  return out;
}

// ---------------- 選択プロンプト応答 ----------------
function renderPromptBar(bar, s) {
  if (s.status !== "waiting" || !canOperate(s)) { bar.style.display = "none"; return; }
  bar.style.display = "flex";  // #d-prompt は CSS で display:none のため、インラインで明示的に上書きする
  const p = s.prompt;
  const opts = p?.options ?? [];
  let html = "";
  if (p?.question) html += `<div class="prompt-q" title="${escAttr(maskText(p.question))}">${esc(maskText(p.question))}</div>`;
  if (opts.length && p.kind === "numbered") {
    html += opts.map((o, i) =>
      `<button class="btn ${i === (p.cursorIndex ?? -1) ? "cursor-on" : ""}" data-mode="num" data-key="${escAttr(o.key)}" data-index="${i}" title="${escAttr(maskText(o.label))}">${esc(o.key)}. ${esc(maskText(o.label.slice(0, 24)))}</button>`
    ).join("");
  } else if (opts.length && p.kind === "cursor") {
    // カーソル選択: クリックで ↑/↓×n → Enter を送る
    html += opts.map((o, i) =>
      `<button class="btn ${i === p.cursorIndex ? "cursor-on" : ""}" data-mode="cursor" data-index="${i}" title="${escAttr(maskText(o.label))}">${i + 1}. ${i === p.cursorIndex ? "❯ " : ""}${esc(maskText(o.label.slice(0, 22)))}</button>`
    ).join("");
    html += `<button class="btn" data-mode="key" data-key="Escape">Esc</button>`;
  } else {
    html += `<button class="btn" data-mode="key" data-key="Up">↑</button>
             <button class="btn" data-mode="key" data-key="Down">↓</button>
             <button class="btn" data-mode="key" data-key="Enter">${t("prompt.confirm")}</button>
             <button class="btn" data-mode="key" data-key="Escape">Esc</button>
             <button class="btn" data-mode="key" data-key="y">y</button>
             <button class="btn" data-mode="key" data-key="n">n</button>`;
  }
  bar.innerHTML = html;
  bar.querySelectorAll("button").forEach(b => {
    b.onclick = async (e) => {
      e.stopPropagation();
      b.disabled = true;
      let r;
      const cursorStyle = b.dataset.mode === "cursor" ||
        (b.dataset.mode === "num" && s.agent === "codex");  // codexの番号付きはカーソル移動で選ぶ
      if (cursorStyle) {
        const delta = Number(b.dataset.index) - (p.cursorIndex ?? 0);
        const keys = [...Array(Math.abs(delta)).fill(delta > 0 ? "Down" : "Up"), "Enter"];
        r = await api("/api/key", { ...target(s), keys });
      } else {
        r = await api("/api/key", { ...target(s), key: b.dataset.key });
      }
      if ((r.result || "").startsWith("ok")) toast(t("toast.sent"));
      else toast(t("toast.sendFailed", { err: r.result }));
    };
  });
}

// ---------------- 操作 ----------------
// 数字キーで許可プロンプトの選択肢に応答(番号型/カーソル型両対応)。グリッド・詳細・リストで共用
// n番目の選択肢まで ↑/↓ を送って Enter で確定(カーソル移動方式)
function answerByCursor(s, n) {
  const delta = (n - 1) - (s.prompt.cursorIndex ?? 0);
  const keys = [...Array(Math.abs(delta)).fill(delta > 0 ? "Down" : "Up"), "Enter"];
  api("/api/key", { ...target(s), keys }).then(() => toast(t("toast.optionConfirmed", { n })));
}
function answerPromptByNumber(sessKey, n) {
  const s = sessionOf(sessKey);
  if (!(s?.status === "waiting" && canOperate(s) && s.prompt)) return false;
  const count = (s.prompt.options ?? []).length;
  if (n > count) return false;
  if (s.prompt.kind === "numbered" && s.agent === "claude") {
    // claude の番号付きプロンプトは数字キーで直接選択できる
    api("/api/key", { ...target(s), key: String(n) }).then(() => toast(t("toast.numberSent", { n })));
    return true;
  }
  // codex の番号付き・両者のカーソル型はカーソル移動+Enter で確定
  answerByCursor(s, n);
  return true;
}
// 空欄 Enter での「確定」: 入力待ちセッションにのみ Enter キーを送る(誤爆防止)
let confirmBusy = false;
async function confirmEnter(key) {
  const s = sessionOf(key);
  if (!canOperate(s) || confirmBusy) return;
  if (s.status !== "waiting") { toast(t("toast.notWaiting")); return; }
  confirmBusy = true;
  try {
    const r = await api("/api/key", { ...target(s), key: "Enter" });
    if ((r.result || "").startsWith("ok")) toast(t("toast.enterSent"));
    else toast(t("toast.sendFailed", { err: r.result }));
  } finally { confirmBusy = false; }
}

async function jump(key) {
  const s = sessionOf(key);
  if (!s) return;
  // リモートでも、手元で ssh + tmux attach しているターミナルがあればそこへ飛べる。
  // 無ければ「開くか?」をモーダルで尋ねる(勝手にタブを増やさない)
  if (s.remote) {
    const r = await api("/api/focus", { cardKey: s.key });
    if (!(r.result || "").startsWith("ok")) openAttach(r.needAttach ?? { host: s.remote.host, tmuxSession: (s.remote.target || "").split(":")[0] });
    return;
  }
  if (!s.tty) { toast(t("toast.ttyJumpUnknown")); return; }
  await api("/api/focus", { tty: s.tty });
}
// textarea の自動リサイズ(改行で上に伸びる)
function autoGrow(ta, max) {
  ta.style.height = "auto";
  ta.style.height = Math.min(ta.scrollHeight, max) + "px";
}
async function sendTo(key, input) {
  const s = sessionOf(key);
  const text = input.value.replace(/\s+$/, "");  // 末尾の空白改行だけ除去(内部改行は保持)
  if (!s || !text.trim() || input.dataset.busy) return;  // 送信中の再入を防ぐ
  if (!canOperate(s)) { toast(t("toast.ttySendUnknown")); return; }
  input.dataset.busy = "1";
  input.value = "";                          // 先にクリアして二重送信を防止
  autoGrow(input, 140);
  const r = await api("/api/send", { ...target(s), text });
  delete input.dataset.busy;
  if ((r.result || "").startsWith("ok")) toast(t("toast.sent"));
  else { input.value = text; autoGrow(input, 140); toast(t("toast.sendFailed", { err: r.result })); }  // 失敗時は復元
}


// ---------------- リモート接続モーダル(f のジャンプ先が無いとき) ----------------
let attachInfo = null;
function openAttach(info) {
  attachInfo = info;
  $("attach-msg").innerHTML = t("attach.body", { host: esc(info.host) });
  $("attach-cmd").textContent = `ssh ${info.host} -t 'tmux attach -t ${info.tmuxSession}'`;
  $("attach-overlay").classList.add("show");
  $("attach-go").focus();
}
function closeAttach() { $("attach-overlay").classList.remove("show"); attachInfo = null; }
async function runAttach() {
  if (!attachInfo) return;
  const info = attachInfo;
  closeAttach();
  const r = await api("/api/remote-attach", info);
  if ((r.result || "").startsWith("ok")) toast(t("attach.opened", { host: info.host }));
  else toast(t("toast.launchFailed", { err: r.error || r.result }));
}
$("attach-go").onclick = runAttach;
$("attach-overlay").onclick = (e) => { if (e.target === $("attach-overlay")) closeAttach(); };

// ---------------- キーボード操作 ----------------
function visibleCards() {
  return [...$("grid").children].sort((a, b) => (Number(a.style.order) || 0) - (Number(b.style.order) || 0));
}
let isInsert = false;  // 入力モード(送信欄フォーカス中)か
function updateKbdSelection() {
  const cards = visibleCards();
  cards.forEach(el => {
    const sel = el.dataset.key === kbdKey;
    el.classList.toggle("kbd-selected", sel && !isInsert);  // ノーマル: 青
    el.classList.toggle("kbd-insert", sel && isInsert);     // 入力: 緑
  });
  if (kbdKey) localStorage.setItem("agd-kbd-key", kbdKey);
  else localStorage.removeItem("agd-kbd-key");
}
document.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT" || e.target.tagName === "TEXTAREA") return;
  if ($("new-overlay").classList.contains("show")) {
    // パレットのノーマルモード(入力欄から Esc で抜けた状態): vim キーで操作
    if (e.key === "j" || e.key === "ArrowDown") { e.preventDefault(); newMoveSel(1); }
    else if (e.key === "k" || e.key === "ArrowUp") { e.preventDefault(); newMoveSel(-1); }
    else if (e.key === "i" || e.key === "/") { e.preventDefault(); $("new-cwd").focus(); }
    else if (e.key === "Tab") { e.preventDefault(); toggleNewAgent(); }
    else if (e.key === "Enter") launchFromPalette();
    else if (e.key === "Escape" || e.key === "q") closeNew();
    return;
  }
  if ($("attach-overlay").classList.contains("show")) {
    if (e.key === "Enter") { e.preventDefault(); runAttach(); }
    else if (e.key === "Escape" || e.key === "q") closeAttach();
    return;
  }
  if ($("help-overlay").classList.contains("show")) {
    if (e.key === "Escape" || e.key === "?" || e.key === "q") closeHelp();
    return;
  }
  // ---- 並列ビュー: 左右のペインをまたいでカーソルを動かす ----
  if (activeTab === "split" && !$("new-overlay").classList.contains("show")) {
    const rows = [...document.querySelectorAll("#list-view .resume-row")];
    const idx = rows.findIndex(r => r.dataset.key === listKey);
    const setSel = (i) => {
      const n = Math.max(0, Math.min(i, rows.length - 1));
      listKey = rows[n]?.dataset.key ?? null;
      updateListSelection();
      rows[n]?.scrollIntoView({ block: "nearest" });
      syncSplitDetail();            // 選んだセッションを右に出す
    };
    if (splitPane === "list") {
      if (e.key === "j" || e.key === "ArrowDown") { e.preventDefault(); setSel(idx < 0 ? 0 : idx + 1); return; }
      if (e.key === "k" || e.key === "ArrowUp") { e.preventDefault(); setSel(idx < 0 ? 0 : idx - 1); return; }
      if (e.key === "g") { setSel(0); return; }
      if (e.key === "G") { setSel(rows.length - 1); return; }
      // 右のペインへ渡る
      if (e.key === "l" || e.key === "ArrowRight" || e.key === "Enter") { e.preventDefault(); setSplitPane("detail"); return; }
      if (e.key === "i") { e.preventDefault(); setSplitPane("detail"); $("d-input").focus(); return; }
    } else {
      // 右(詳細)にいるとき、左端で h / ← なら一覧へ戻る
      if ((e.key === "h" || e.key === "ArrowLeft") && detailSel < 0) { e.preventDefault(); setSplitPane("list"); return; }
      if (e.key === "Escape" && document.activeElement !== $("d-input")) { e.preventDefault(); setSplitPane("list"); return; }
    }
  }
  if ($("overlay").classList.contains("show")) {
    // 詳細画面のノーマルモード: エントリ(ボックス)を選択して開閉する
    if (e.key === "j" || e.key === "ArrowDown") { e.preventDefault(); moveDetailSel(1); }
    else if (e.key === "k" || e.key === "ArrowUp") { e.preventDefault(); moveDetailSel(-1); }
    else if (e.key === "d") { e.preventDefault(); moveDetailSel(5); }
    else if (e.key === "u") { e.preventDefault(); moveDetailSel(-5); }
    else if (e.key === "g") { detailSel = 0; updateDetailSel(); }
    else if (e.key === "G") { detailSel = detailEntryEls().length - 1; updateDetailSel(); }
    else if (e.key === "Enter" || e.key === "o") { e.preventDefault(); toggleDetailEntry(); }
    else if (e.key === "l") toggleDetailEntry(true);
    else if (e.key === "h") toggleDetailEntry(false);
    else if (/^[1-9]$/.test(e.key) && detailKey) answerPromptByNumber(detailKey, Number(e.key));
    else if (e.key === "i") { e.preventDefault(); $("d-input").focus(); }
    // 表示中のセッションを対象に複製 / 会話を fork して新タブ起動(グリッドと同じ操作感)
    else if (e.ctrlKey && (e.key === "n" || e.key === "N") && detailKey) { e.preventDefault(); duplicateSession(detailKey); }
    else if (e.ctrlKey && (e.key === "c" || e.key === "C") && detailKey) { e.preventDefault(); resumeContinue(detailKey); }
    else if (e.key === "f" && detailKey) jump(detailKey);
    else if (e.key === "s" && detailKey) sendNamedKey("Escape", t("action.interrupt"));
    else if (e.key === "m" && detailKey) sendNamedKey("ShiftTab", t("action.mode"));
    else if (e.key === ":") { e.preventDefault(); openCmdline(); }
    else if (e.key === "Escape" || e.key === "q") closeDetail();
    return;
  }
  if ($("search-overlay").classList.contains("show")) {
    if (e.key === "Escape") closeSearch();
    return;
  }
  if (e.key === "t") {
    const order = ["list", "split", "grid"];   // タブの並び順にトグルする
    setTab(order[(order.indexOf(activeTab) + 1) % order.length]);
    return;
  }
  if (e.key === ":") { e.preventDefault(); openCmdline(); return; }
  if (e.key === "?") { e.preventDefault(); toggleHelp(); return; }
  if (activeTab === "list") {
    // セッションタブ: vim風の行選択と操作
    const rows = [...document.querySelectorAll("#list-view .resume-row")];
    const idx = rows.findIndex(r => r.dataset.key === listKey);
    const setSel = (i) => {
      const t = Math.max(0, Math.min(i, rows.length - 1));
      listKey = rows[t]?.dataset.key ?? null;
      updateListSelection();
      rows[t]?.scrollIntoView({ block: "nearest" });
    };
    const s = sessionOf(listKey);
    if (e.key === "j" || e.key === "ArrowDown") { e.preventDefault(); setSel(idx < 0 ? 0 : idx + 1); }
    else if (e.key === "k" || e.key === "ArrowUp") { e.preventDefault(); setSel(idx < 0 ? 0 : idx - 1); }
    else if (e.key === "g") setSel(0);
    else if (e.key === "G") setSel(rows.length - 1);
    else if (e.key === "i" && s) { e.preventDefault(); s.running ? openDetail(listKey) : resumeSession(s); }
    else if (e.key === "o" && s) openDetail(listKey);
    else if (e.key === "f" && s?.running) jump(listKey);
    else if (e.key === "Enter" && s) { s.running ? confirmEnter(listKey) : resumeSession(s); }
    else if (e.key === "m" && s?.running) sendNamedKey("ShiftTab", t("action.mode"));
    else if (e.key === "s" && s?.running) sendNamedKey("Escape", t("action.interrupt"));
    else if (e.ctrlKey && (e.key === "c" || e.key === "C") && s) { e.preventDefault(); resumeContinue(listKey); }
    else if (/^[1-9]$/.test(e.key) && s?.running) answerPromptByNumber(listKey, Number(e.key));
    else if (e.key === "p" && s) togglePin(listKey);
    else if (e.key === "n") { e.preventDefault(); openNew(); }
    else if (e.key === "/") { e.preventDefault(); $("search").focus(); }
    return;
  }
  // vim風ノーマルモード: hjkl で上下左右移動(選択はカードに追従)、i で入力モードへ
  const cards = visibleCards();
  const curIdx = cards.findIndex(el => el.dataset.key === kbdKey);
  const selectIdx = (i) => { kbdKey = cards[i]?.dataset.key ?? null; updateKbdSelection(); };
  const move = (dx, dy) => {
    e.preventDefault();
    if (!cards.length) return;
    if (curIdx < 0) { selectIdx(0); return; }
    if (dx) {
      const col = curIdx % gridCols;
      const row = Math.floor(curIdx / gridCols);
      const ni = curIdx + dx;
      if (dx > 0 && (col === gridCols - 1 || ni >= cards.length)) {
        // 右端の列 → 次ページ(同じ行の左端に着地)
        if (!$("page-next").disabled) {
          $("page-next").click();
          const c2 = visibleCards();
          kbdKey = (c2[row * gridCols] ?? c2[0])?.dataset.key ?? null;
          updateKbdSelection();
        }
      } else if (dx < 0 && col === 0) {
        // 左端の列 → 前ページ(同じ行の右端に着地)
        if (page > 0) {
          $("page-prev").click();
          const c2 = visibleCards();
          kbdKey = (c2[row * gridCols + gridCols - 1] ?? c2[c2.length - 1])?.dataset.key ?? null;
          updateKbdSelection();
        }
      } else selectIdx(ni);
    }
    if (dy) {
      const ni = curIdx + dy * gridCols;
      if (ni >= 0 && ni < cards.length) selectIdx(ni);
    }
  };
  const sel = curIdx >= 0 ? cards[curIdx] : null;
  const shiftKeyOf = (c) => e.shiftKey && e.key.toLowerCase() === c;
  if (shiftKeyOf("h") && kbdKey) moveCard(kbdKey, -1);
  else if (shiftKeyOf("l") && kbdKey) moveCard(kbdKey, 1);
  else if (shiftKeyOf("k") && kbdKey) moveCard(kbdKey, -gridCols);
  else if (shiftKeyOf("j") && kbdKey) moveCard(kbdKey, gridCols);
  else if (e.key === "h" || e.key === "ArrowLeft") move(-1, 0);
  else if (e.key === "l" || e.key === "ArrowRight") move(1, 0);
  else if (e.key === "j" || e.key === "ArrowDown") move(0, 1);
  else if (e.key === "k" || e.key === "ArrowUp") move(0, -1);
  else if (e.key === "]" || (e.ctrlKey && e.key === "f")) { e.preventDefault(); $("page-next").click(); }
  else if (e.key === "[" || (e.ctrlKey && e.key === "b")) { e.preventDefault(); $("page-prev").click(); }
  else if (e.key === "g") { page = 0; render(); const c = visibleCards(); kbdKey = c[0]?.dataset.key ?? kbdKey; updateKbdSelection(); }
  else if (e.key === "G") {
    const list = orderedFiltered();
    page = Math.max(0, Math.ceil(list.length / Number($("per-page").value)) - 1);
    render();
    const c = visibleCards();
    kbdKey = c[c.length - 1]?.dataset.key ?? kbdKey;
    updateKbdSelection();
  }
  else if (e.key === "i" && sel) {
    e.preventDefault();  // "i" が入力欄に入らないように
    sel.querySelector(".send-row textarea")?.focus();
  }
  else if (e.key === "Enter" && sel) confirmEnter(kbdKey);
  else if (e.key === "o" && sel) openDetail(kbdKey);
  else if (e.key === "f" && sel) jump(kbdKey);
  else if (e.ctrlKey && (e.key === "n" || e.key === "N")) { e.preventDefault(); duplicateSession(kbdKey); }
  else if (e.ctrlKey && (e.key === "c" || e.key === "C")) { e.preventDefault(); resumeContinue(kbdKey); }
  else if (e.key === "n") { e.preventDefault(); openNew(); }
  else if (e.key === "m" && kbdKey) sendNamedKey("ShiftTab", t("action.mode"));
  else if (e.key === "s" && kbdKey) sendNamedKey("Escape", t("action.interrupt"));
  else if (e.key === "p" && kbdKey) togglePin(kbdKey);
  else if (e.key === "/") { e.preventDefault(); $("search").focus(); }
  else if (/^[1-9]$/.test(e.key) && sel) answerPromptByNumber(kbdKey, Number(e.key));
});

// ---------------- 詳細ビュー ----------------
let lastLogLength = 0;
let detailScrolled = false;
let detailSel = -1;             // ログ内で選択中のエントリindex(-1 = 末尾追従)
let detailOpen = new Set();     // 開いている折りたたみエントリのindex

function detailEntryEls() { return [...$("detail-log").children].filter(el => el.classList.contains("entry")); }
function updateDetailSel(scroll = true) {
  const es = detailEntryEls();
  es.forEach((el, i) => el.classList.toggle("entry-sel", i === detailSel));
  if (scroll && detailSel >= 0 && es[detailSel]) es[detailSel].scrollIntoView({ block: "nearest" });
}
function moveDetailSel(d) {
  const es = detailEntryEls();
  if (!es.length) return;
  detailSel = detailSel < 0 ? es.length - 1 : Math.max(0, Math.min(detailSel + d, es.length - 1));
  updateDetailSel();
}
function toggleDetailEntry(forceOpen) {
  const el = detailEntryEls()[detailSel];
  const det = el?.querySelector("details");
  if (!det) return;
  det.open = forceOpen !== undefined ? forceOpen : !det.open;
  if (det.open) detailOpen.add(detailSel); else detailOpen.delete(detailSel);
  el.scrollIntoView({ block: "nearest" });
}
async function openDetail(key) {
  clearInterval(logTimer);  // 前セッションの更新タイマーを先に止める(切替時の上書き防止)
  detailKey = key;
  const s = sessionOf(key);
  if (!s) return;
  $("overlay").classList.add("show");
  $("d-agent").textContent = s.agent;
  $("d-title").innerHTML =
    esc(maskText(s.name)) + (s.title ? ` <span class="ai-title">${esc(maskText(s.title))}</span>` : "");
  $("d-meta").textContent = `${shortCwd(s.cwd)} · ${t(`status.${s.status}`)}`;
  $("d-dot").style.background = getComputedStyle(document.documentElement).getPropertyValue(`--${s.status}`) || "#666";
  detailScrolled = false;
  detailSel = -1;
  detailOpen = new Set();
  detailSub = null;
  $("d-sub").style.display = "none";
  $("d-sub").value = "";
  loadSubagents(s);
  $("d-latest").style.display = "none";
  setScreen($("d-screen"), s.screen ?? t("detail.screenUnavailable"));
  $("d-screen").scrollTop = $("d-screen").scrollHeight;
  $("d-input").dataset.tty = s.tty ?? "";
  $("d-jump").style.display = s.tty || s.remote ? "" : "none";
  $("d-jump").onclick = () => jump(key);
  renderPromptBar($("d-prompt"), s);
  $("d-input").blur();  // デフォルトはスクロールモード。i で入力モードへ
  $("d-kbd-hint").innerHTML = t("hint.detailScroll");
  await loadLog(s, true);
  clearInterval(logTimer);
  logTimer = setInterval(() => {
    if (document.hidden) return;   // 背面では更新しない
    const cur = sessionOf(detailKey);
    if (cur) {
      if (cur.screen && setScreen($("d-screen"), cur.screen)) {
        if (!detailScrolled) $("d-screen").scrollTop = $("d-screen").scrollHeight;
      }
      renderPromptBar($("d-prompt"), cur);
      loadSubagents(cur);
      loadLog(cur, false);
    }
  }, 3000);
}
$("d-screen").onscroll = () => {
  const el = $("d-screen");
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
  detailScrolled = !atBottom;
  $("d-latest").style.display = atBottom ? "none" : "";
};
$("d-latest").onclick = () => {
  detailScrolled = false;
  $("d-screen").scrollTop = $("d-screen").scrollHeight;
  $("d-latest").style.display = "none";
};
// Edit/Write/patch系ツールの入力を diff 表示に整形
function renderToolUse(e) {
  let obj = null;
  try { obj = JSON.parse(e.text); } catch {}
  if (obj && typeof obj === "object") {
    if (typeof obj.old_string === "string" && typeof obj.new_string === "string") {
      const del = obj.old_string.split("\n").map(l => `<span class="diff-line diff-del">- ${esc(l)}</span>`).join("");
      const add = obj.new_string.split("\n").map(l => `<span class="diff-line diff-add">+ ${esc(l)}</span>`).join("");
      return `<span class="diff-file">${esc(obj.file_path ?? "")}</span>\n${del}${add}`;
    }
    if (typeof obj.content === "string" && obj.file_path) {
      const add = obj.content.split("\n").slice(0, 200).map(l => `<span class="diff-line diff-add">+ ${esc(l)}</span>`).join("");
      return `<span class="diff-file">${esc(obj.file_path)}</span>\n${add}`;
    }
    if (typeof obj.command === "string") return `$ ${linkify(esc(obj.command))}${obj.description ? `\n# ${esc(obj.description)}` : ""}`;
    if (typeof obj.input === "string" && obj.input.includes("*** Begin Patch")) obj = obj.input;
  }
  const text = typeof obj === "string" ? obj : e.text;
  if (text.includes("*** Begin Patch") || /^diff --git/m.test(text)) {
    return text.split("\n").map(l => {
      if (l.startsWith("+") && !l.startsWith("+++")) return `<span class="diff-line diff-add">${esc(l)}</span>`;
      if (l.startsWith("-") && !l.startsWith("---")) return `<span class="diff-line diff-del">${esc(l)}</span>`;
      return `<span class="diff-line">${esc(l)}</span>`;
    }).join("");
  }
  return linkify(esc(e.text));
}
// ログ読み込み状態(表示中ウィンドウ)
let logEntries = [];
let logStart = 0;   // logEntries[0] の全体index
let logTotal = 0;

let detailSub = null;  // 表示中のサブエージェントID(null = 本体)
async function fetchTranscript(s, params = {}) {
  const q = new URLSearchParams({ agent: s.agent, sid: s.sid, ...(detailSub ? { sub: detailSub } : {}), ...params });
  const r = await fetch(`/api/transcript?${q}`);
  return r.json();
}
// サブエージェント一覧をセレクタに反映(claude のみ)
async function loadSubagents(s) {
  if (s.agent !== "claude") { $("d-sub").style.display = "none"; return; }
  try {
    const r = await fetch(`/api/subagents?agent=claude&sid=${encodeURIComponent(s.sid)}`);
    const { subagents } = await r.json();
    const sel = $("d-sub");
    if (!subagents.length) { sel.style.display = "none"; return; }
    const cur = sel.value;
    sel.innerHTML = `<option value="">${t("detail.main")}</option>` + subagents.map(a =>
      `<option value="${escAttr(a.id)}">${a.active ? "● " : ""}sub: ${esc(maskText(a.name))}</option>`).join("");
    sel.value = [...sel.options].some(o => o.value === cur) ? cur : "";
    sel.style.display = "";
  } catch {}
}
$("d-sub").onchange = async () => {
  detailSub = $("d-sub").value || null;
  detailSel = -1;
  detailOpen = new Set();
  logStart = 0;
  const s = sessionOf(detailKey);
  if (s) await loadLog(s, true);
};
let logSeq = 0;  // 読み込み世代。古い応答が新しい表示を上書きするレースを防ぐ
async function loadLog(s, force) {
  const seq = ++logSeq;
  const data = force
    ? await fetchTranscript(s)                          // 末尾300件
    : await fetchTranscript(s, { from: logStart });     // 読み込み済み範囲以降を更新
  if (seq !== logSeq) return;  // この取得中に別セッション/サブへ切り替わった → 破棄
  if (!force && data.entries.length === logEntries.length && data.total === logTotal) return;
  if (force) logStart = data.start;
  logEntries = data.entries;
  logTotal = data.total;
  renderLog(force);
}
// 過去へ遡って追加読み込み(選択・開閉のindexをシフトして維持)
async function loadOlder() {
  const s = sessionOf(detailKey);
  if (!s || logStart <= 0) return;
  const log = $("detail-log");
  const prevHeight = log.scrollHeight;
  const seq = ++logSeq;
  const data = await fetchTranscript(s, { before: logStart });
  if (seq !== logSeq) return;
  const added = data.entries.length;
  logEntries = [...data.entries, ...logEntries];
  logStart = data.start;
  logTotal = data.total;
  if (detailSel >= 0) detailSel += added;
  detailOpen = new Set([...detailOpen].map(i => i + added));
  renderLog(false);
  log.scrollTop += log.scrollHeight - prevHeight;  // 見ていた位置を維持
}
function renderLog(force) {
  const log = $("detail-log");
  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
  const older = logStart > 0
    ? `<div class="load-older" onclick="loadOlder()">${t("detail.loadOlderCount", { n: logStart })}</div>` : "";
  log.innerHTML = older + logEntries.map((e0, idx) => {
    const e = maskMode ? { ...e0, text: maskText(e0.text) } : e0;
    const ts = e.ts ? `<span class="ts">${e.ts.slice(11, 19)}</span> ` : "";
    if (e.role === "user") return `<div class="entry user">${ts}${linkify(esc(e.text))}</div>`;
    if (e.role === "assistant") return `<div class="entry assistant">${ts}${linkify(esc(e.text))}</div>`;
    const label = e.role === "thinking" ? t("detail.thinking") : e.role === "tool_use" ? `🔧 ${esc(e.title ?? "tool")}` : t("detail.result");
    const body = e.role === "tool_use" ? renderToolUse(e) : linkify(esc(e.text));
    const more = e.truncated ? `<div class="load-full" data-i="${idx}">${t("detail.showFull", { limit: t("detail.truncateLabel") })}</div>` : "";
    return `<div class="entry ${e.role}"><details${detailOpen.has(idx) ? " open" : ""}><summary>${ts}${label}</summary><pre>${body}</pre>${more}</details></div>`;
  }).join("");
  // クリック選択・マウス開閉の同期・全文展開
  detailEntryEls().forEach((el, i) => {
    el.onclick = () => { detailSel = i; updateDetailSel(false); };
    const det = el.querySelector("details");
    if (det) det.ontoggle = () => { if (det.open) detailOpen.add(i); else detailOpen.delete(i); };
    const full = el.querySelector(".load-full");
    if (full) full.onclick = async (ev) => {
      ev.stopPropagation();
      const s = sessionOf(detailKey);
      if (!s) return;
      const { entry } = await fetchTranscript(s, { entry: logStart + i });
      if (entry) {
        const me = maskMode ? { ...entry, text: maskText(entry.text) } : entry;
        const pre = el.querySelector("pre");
        pre.innerHTML = me.role === "tool_use" ? renderToolUse(me) : linkify(esc(me.text));
        full.remove();
      }
    };
  });
  if (detailSel >= logEntries.length) detailSel = logEntries.length - 1;
  updateDetailSel(false);
  if (force || nearBottom) log.scrollTop = log.scrollHeight;
}
function closeDetail() {
  $("overlay").classList.remove("show");
  detailKey = null;
  logEntries = [];
  logStart = 0;
  logTotal = 0;
  clearInterval(logTimer);
}
$("overlay").onclick = (e) => { if (e.target === $("overlay")) closeDetail(); };
let detailSendBusy = false;
async function sendDetail() {
  const s = sessionOf(detailKey);
  const text = $("d-input").value.replace(/\s+$/, "");
  if (!text) { if (detailKey) confirmEnter(detailKey); return; }
  if (!canOperate(s)) { toast(t("toast.detailNotRunning")); return; }
  if (detailSendBusy) return;                // 送信中の再入を防ぐ
  detailSendBusy = true;
  $("d-input").value = "";                   // 先にクリアして二重送信を防止
  autoGrow($("d-input"), 200);
  const r = await api("/api/send", { ...target(s), text });
  detailSendBusy = false;
  if ((r.result || "").startsWith("ok")) toast(t("toast.sent"));
  else { $("d-input").value = text; autoGrow($("d-input"), 200); toast(t("toast.sendFailed", { err: r.result })); }
}
$("d-input").oninput = () => { updateSlashHints($("d-input"), () => sessionOf(detailKey)); autoGrow($("d-input"), 200); };
$("d-input").onkeydown = (e) => {
  e.stopPropagation();
  if (e.isComposing || e.keyCode === 229) return;  // IME変換中は無視
  if (handleHintKeys(e, $("d-input"))) return;
  // 入力中でも複製 / fork を効かせる。ただし Ctrl+C はテキスト選択中なら
  // ブラウザ既定のコピーを優先する(選択が無いときだけ fork とみなす)
  if (e.ctrlKey && (e.key === "n" || e.key === "N") && detailKey) { e.preventDefault(); duplicateSession(detailKey); return; }
  if (e.ctrlKey && (e.key === "c" || e.key === "C") && detailKey
      && e.target.selectionStart === e.target.selectionEnd) { e.preventDefault(); resumeContinue(detailKey); return; }
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendDetail(); }  // ⇧⏎ は改行
  if (e.key === "Escape") $("d-input").blur();  // スクロールモードへ(閉じるのは q/Esc)
};
$("d-input").onfocus = () => { $("d-kbd-hint").innerHTML = t("hint.detailInsert"); };
$("d-input").onblur = () => { hideHints(); $("d-kbd-hint").innerHTML = t("hint.detailScroll"); };

// ---------------- ログ横断検索 ----------------
async function runSearch(q) {
  $("search-overlay").classList.add("show");
  $("search-q").textContent = q;
  $("search-results").textContent = t("search.searching");
  const r = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
  const { hits, indexing } = await r.json();
  if (!hits.length) { $("search-results").textContent = t("search.noHits"); return; }
  $("search-results").innerHTML = "";
  if (indexing) {
    const note = document.createElement('div');
    note.className = "card-meta";
    note.textContent = t("search.indexing", { done: indexing.done, total: indexing.total });
    $("search-results").appendChild(note);
  }
  hits.forEach(h => {
    const row = document.createElement('div');
    row.className = "hit-row";
    row.innerHTML = `
      <span class="agent-tag">${h.agent}</span>
      <span class="proj-tag" style="background:${projColor(h.cwd)}">${esc(projName(h.cwd))}</span>
      <strong></strong>
      <span class="card-meta"> ${t("search.hits", { n: h.count })} · ${fmtAge(Math.floor((Date.now() - h.mtime) / 1000))}</span>
      <div class="snippet"></div>`;
    row.querySelector("strong").textContent = maskText(h.name);
    row.querySelector(".snippet").textContent = maskText(h.snippet);
    row.onclick = () => {
      closeSearch();
      if (!sessionOf(`${h.agent}:${h.sid}`)) {
        sessions.push({ key: `${h.agent}:${h.sid}`, agent: h.agent, sid: h.sid, name: h.name, cwd: h.cwd, status: "resumable", running: false, tty: "", ageS: 0 });
      }
      openDetail(`${h.agent}:${h.sid}`);
    };
    $("search-results").appendChild(row);
  });
}
function closeSearch() { $("search-overlay").classList.remove("show"); }
$("search-overlay").onclick = (e) => { if (e.target === $("search-overlay")) closeSearch(); };

// ---------------- 新規セッション(コマンドパレット型) ----------------
let newAgent = "claude";
let newProjects = [];   // {cwd, ageS}
let newSel = 0;
let newLaunchBusy = false;
let pendingSelect = null;  // 起動後、新カード出現時に選択を移すための待ち受け

function openNew() {
  $("new-overlay").classList.add("show");
  $("new-cwd").value = "";
  newSel = 0;
  // 候補はセッション一覧から最終アクティビティ順に(APIの一覧も合流)
  const ageByCwd = new Map();
  sessions.forEach(s => {
    if (!s.cwd) return;
    ageByCwd.set(s.cwd, Math.min(ageByCwd.get(s.cwd) ?? Infinity, s.ageS));
  });
  fetch("/api/projects").then(r => r.json()).then(({ projects }) => {
    projects.forEach(p => { if (!ageByCwd.has(p)) ageByCwd.set(p, Infinity); });
    newProjects = [...ageByCwd.entries()]
      .map(([cwd, ageS]) => ({ cwd, ageS }))
      .sort((a, b) => a.ageS - b.ageS);
    renderNewList();
  });
  // デフォルトはノーマルモード(候補先頭を選択)。入力するときは i または /
  $("new-cwd").blur();
}
function closeNew() { $("new-overlay").classList.remove("show"); }
let newDirCands = [];  // パス入力モードのディレクトリ候補
let newDirExists = false;  // 入力中のパスが既存ディレクトリか
let dirFetchSeq = 0;
function isPathMode() {
  const q = $("new-cwd").value.trim();
  return q.startsWith("/") || q.startsWith("~");
}
function newFiltered() {
  const q = $("new-cwd").value.trim();
  if (isPathMode()) {
    if (newDirCands.length) return newDirCands.map(d => ({ cwd: d, ageS: Infinity }));
    // 補完候補なし & 未存在パス → 「作成して起動」を選択肢として出す
    if (!newDirExists && q.length > 1 && !q.endsWith("/")) return [{ cwd: q, ageS: Infinity, create: true }];
    return [];
  }
  const ql = q.toLowerCase();
  return newProjects.filter(p => !ql || p.cwd.toLowerCase().includes(ql)).slice(0, 12);
}
async function fetchDirCands() {
  const q = $("new-cwd").value.trim();
  const seq = ++dirFetchSeq;
  try {
    const r = await fetch(`/api/dirs?q=${encodeURIComponent(q)}`);
    const { dirs, exists } = await r.json();
    if (seq !== dirFetchSeq) return;  // 入力が進んでいたら破棄
    newDirCands = dirs;
    newDirExists = !!exists;
    renderNewList();
  } catch {}
}
function renderNewList() {
  const list = newFiltered();
  if (newSel >= list.length) newSel = Math.max(0, list.length - 1);
  $("new-list").innerHTML = list.map((p, i) => p.create ? `
    <div class="proj-row ${i === newSel ? "sel" : ""}" data-cwd="${escAttr(p.cwd)}" data-create="1">
      <span>${t("new.createDirLaunch", { path: esc(shortCwd(p.cwd)) })}</span>
    </div>` : `
    <div class="proj-row ${i === newSel ? "sel" : ""}" data-cwd="${escAttr(p.cwd)}">
      <span class="proj-tag" style="background:${projColor(p.cwd)}">${esc(projName(p.cwd))}</span>
      <span>${esc(shortCwd(p.cwd))}</span>
      <span class="card-meta">${p.ageS === Infinity ? "" : fmtAge(p.ageS)}</span>
    </div>`).join("");
  [...$("new-list").children].forEach(row => {
    row.onclick = () => launchNew(newAgent, row.dataset.cwd, row.dataset.create === "1");
  });
}
async function launchNew(agent, cwd, create = false) {
  if (!cwd || newLaunchBusy) return;
  newLaunchBusy = true;
  const r = await api("/api/new", { agent, cwd, create });
  newLaunchBusy = false;
  if (r.error) { toast(t("toast.launchFailed", { err: r.error })); return; }
  pendingSelect = {
    agent, cwd,
    keys: new Set(sessions.filter(x => x.running).map(x => x.key)),
    until: Date.now() + 30_000,
  };
  closeNew();
  toast(t("toast.launched", { agent, project: projName(cwd) }));
}
// Ctrl+N: 選択カードと同じプロジェクト・同じエージェントで複製起動
function duplicateSession(key) {
  const s = sessionOf(key);
  if (!s?.cwd) { toast(t("toast.noCardSelected")); return; }
  launchNew(s.agent, s.cwd);
}
// Ctrl+C: 選択セッションの会話を resume で引き継いで新タブ起動(claude/codex 両対応)
async function resumeContinue(key) {
  const s = sessionOf(key);
  if (!s?.sid || !s?.cwd) { toast(t("toast.noResumable")); return; }
  // fork: 新しいセッションIDに分岐(素のresumeだと両プロセスが同一ログに追記して交錯する)
  await api("/api/resume", { agent: s.agent, sid: s.sid, cwd: s.cwd, fork: true });
  pendingSelect = {
    agent: s.agent, cwd: s.cwd,
    keys: new Set(sessions.filter(x => x.running).map(x => x.key)),
    until: Date.now() + 30_000,
  };
  toast(t("toast.forked", { agent: s.agent }));
}
function toggleNewAgent() {
  newAgent = newAgent === "claude" ? "codex" : "claude";
  $("new-agent-chip").textContent = newAgent;
}
$("new-btn").onclick = openNew;
$("new-agent-chip").onclick = toggleNewAgent;
$("new-overlay").onclick = (e) => { if (e.target === $("new-overlay")) closeNew(); };
$("new-cwd").oninput = () => {
  newSel = 0;
  if (isPathMode()) fetchDirCands();
  else { newDirCands = []; renderNewList(); }
};
function launchFromPalette() {
  const typed = $("new-cwd").value.trim();
  // パス入力モードでもディレクトリ候補が選択されていればそれを優先
  const item = newFiltered()[newSel];
  const cwd = item?.cwd ?? (isPathMode() ? typed : undefined);
  if (cwd) launchNew(newAgent, cwd, !!item?.create);
}
function newMoveSel(d) {
  const list = newFiltered();
  newSel = Math.max(0, Math.min(newSel + d, list.length - 1));
  renderNewList();
  document.querySelector("#new-list .proj-row.sel")?.scrollIntoView({ block: "nearest" });
}
$("new-cwd").onkeydown = (e) => {
  e.stopPropagation();
  if (e.isComposing || e.keyCode === 229) return;  // IME変換中は無視
  if (e.key === "Tab" && isPathMode()) {
    // パス入力モードの Tab は選択候補で補完して掘り下げ
    e.preventDefault();
    const c = newFiltered()[newSel]?.cwd;
    if (c) { $("new-cwd").value = c + "/"; newSel = 0; fetchDirCands(); }
  }
  else if (e.key === "Tab") { e.preventDefault(); toggleNewAgent(); }
  else if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "j")) { e.preventDefault(); newMoveSel(1); }
  else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "k")) { e.preventDefault(); newMoveSel(-1); }
  else if (e.key === "Enter") launchFromPalette();
  else if (e.key === "Escape") $("new-cwd").blur();  // vim風: Esc でパレットのノーマルモードへ
};

// 前回のタブを復元(既定は画面一覧)。render を伴うので、
// 後方の const 宣言がすべて評価された最後に呼ぶ
setTab(activeTab);
