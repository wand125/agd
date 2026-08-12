// agd モバイルビュー(監視盤)。
//
// デスクトップ版とは別物として作る。共通ロジックは core.js にあり、ここは
// 「38セッションをスマホで俯瞰し、詰まっているものに気づいて最小限応答する」
// ことだけに責任を持つ。キーボード操作・ピン留め・ページャ・新規起動は持たない。
const $ = (id) => document.getElementById(id);

const STATUSES = ["waiting", "busy", "idle", "resumable"];
let filter = new Set(JSON.parse(localStorage.getItem("agd-m-filter") || '["waiting","busy","idle"]'));
let query = "";
let openKey = null;          // 詳細で開いているセッション
let dTab = "screen";
let logTimer = null;
let lastRender = 0;
let readOnly = false;   // サーバーが AGD_READONLY で起動している

// ---------------- 一覧 ----------------
function visible() {
  const q = query.trim().toLowerCase();
  return agd.sessions
    .filter(s => filter.has(s.status))
    .filter(s => !q || `${s.name} ${s.cwd} ${s.summary ?? ""}`.toLowerCase().includes(q))
    // 詰まっているものを上に。同状態なら新しい順
    .sort((a, b) => STATUSES.indexOf(a.status) - STATUSES.indexOf(b.status) || a.ageS - b.ageS);
}

function renderCounts() {
  const c = { waiting: 0, busy: 0, idle: 0 };
  for (const s of agd.sessions) if (c[s.status] !== undefined) c[s.status]++;
  $("counts").innerHTML =
    `<span class="c-waiting">▲<b>${c.waiting}</b></span>` +
    `<span class="c-busy">●<b>${c.busy}</b></span>` +
    `<span class="c-idle">○<b>${c.idle}</b></span>`;
}

function renderList() {
  renderCounts();
  const list = visible();
  const el = $("list");
  if (!list.length) { el.innerHTML = `<div class="empty">該当するセッションがありません</div>`; return; }
  el.innerHTML = list.map(s => {
    const host = s.remote ? `<span class="host">${esc(s.remote.host)}</span>` : "";
    // 入力待ちは一覧から直接答えられるようにする(詳細を開かせない)
    const answers = !readOnly && s.status === "waiting" && s.prompt?.options?.length
      ? `<div class="answers">${s.prompt.options.slice(0, 4).map((o, i) =>
          `<button class="abtn" data-k="${esc(s.key)}" data-a="${i + 1}">${esc(maskText(o.label)).slice(0, 24)}</button>`).join("")}</div>`
      : "";
    return `<div class="row ${s.status}" data-k="${esc(s.key)}">
      <span class="dot ${s.status}"></span>
      <div class="body">
        <div class="line1">
          <span class="proj" style="background:${projColor(s.cwd)}">${esc(projName(s.cwd))}</span>
          <span class="name">${esc(maskText(s.name))}</span>
          ${host}<span class="age">${fmtAge(s.ageS)}</span>
        </div>
        ${s.title ? `<div class="ai-title">${esc(maskText(s.title))}</div>` : ""}
        ${s.summary ? `<div class="sum">${esc(maskText(s.summary))}</div>` : ""}
        ${answers}
      </div>
    </div>`;
  }).join("");
}

$("list").onclick = (e) => {
  const btn = e.target.closest(".abtn");
  if (btn) {                                  // 一覧から即応答
    e.stopPropagation();
    const s = sessionOf(btn.dataset.k);
    if (s) answer(s, btn.dataset.a);
    return;
  }
  const row = e.target.closest(".row");
  if (row) openDetail(row.dataset.k);
};

async function answer(s, n) {
  const r = await answerPrompt(s, Number(n));
  toast(r ? "送信しました" : "応答できませんでした");
}

// ---------------- フィルタ ----------------
function renderFilters() {
  $("filters").innerHTML = STATUSES.map(s =>
    `<span class="chip ${filter.has(s) ? "on" : ""}" data-s="${s}">${
      { waiting: "▲ 入力待ち", busy: "● 実行中", idle: "○ 待機", resumable: "resume可" }[s]}</span>`).join("");
}
$("filters").onclick = (e) => {
  const c = e.target.closest(".chip");
  if (!c) return;
  const s = c.dataset.s;
  filter.has(s) ? filter.delete(s) : filter.add(s);
  localStorage.setItem("agd-m-filter", JSON.stringify([...filter]));
  renderFilters(); renderList();
};
$("btn-f").onclick = () => $("filters").classList.toggle("on");
$("btn-q").onclick = () => {
  const on = $("qwrap").classList.toggle("on");
  if (on) $("q").focus(); else { $("q").value = ""; query = ""; renderList(); }
};
$("q").oninput = (e) => { query = e.target.value; renderList(); };

// ---------------- 詳細 ----------------
async function openDetail(key) {
  const s = sessionOf(key);
  if (!s) return;
  openKey = key;
  $("detail").classList.add("on");
  $("dtitle").innerHTML = esc(maskText(s.name))
    + (s.title ? ` <span class="ai-title">${esc(maskText(s.title))}</span>` : "");
  $("dmeta").textContent = `${shortCwd(s.cwd)} · ${s.status}`;
  $("ddot").className = `dot ${s.status}`;
  setTab("screen", true);
  paintDetail(s, true);
  $("dlog").innerHTML = `<div class="empty">読み込み中…</div>`;
  await loadLog(s, true);
  clearInterval(logTimer);
  logTimer = setInterval(async () => {
    const cur = sessionOf(openKey);
    if (!cur) return;
    paintDetail(cur);
    if (dTab === "log") await loadLog(cur);
  }, 4000);
}
function closeDetail() {
  $("detail").classList.remove("on");
  openKey = null;
  clearInterval(logTimer);
}
$("dback").onclick = closeDetail;

// スクロールするのは #dbody。#dscreen / #dlog は中身なので自身では動かない
function atBottom(margin = 60) {
  const b = $("dbody");
  return b.scrollTop + b.clientHeight >= b.scrollHeight - margin;
}
function toBottom() { const b = $("dbody"); b.scrollTop = b.scrollHeight; }

function paintDetail(s, force = false) {
  const stick = force || atBottom();
  if (setScreen($("dscreen"), s.screen ?? "(画面を取得できません)") && stick) toBottom();
  if (force) toBottom();
  // 入力待ちなら応答ボタンを出す
  const p = s.prompt;
  if (!readOnly && s.status === "waiting" && p?.options?.length) {
    $("dprompt").classList.add("on");
    $("dpq").textContent = maskText(p.question ?? "");
    $("dpa").innerHTML = p.options.map((o, i) =>
      `<button class="abtn" data-a="${i + 1}">${esc(maskText(o.label)).slice(0, 30)}</button>`).join("");
  } else $("dprompt").classList.remove("on");
}
$("dpa").onclick = (e) => {
  const b = e.target.closest(".abtn");
  const s = sessionOf(openKey);
  if (b && s) answer(s, b.dataset.a);
};

// 詳細内のスワイプ操作。
//   左右フリック          → 画面 ⇄ ログ のタブ切替
//   画面左端からの右フリック → 一覧へ戻る(iOS の「戻る」に合わせる)
// 縦スクロールと端末画面の横スクロールを邪魔しないよう、横移動が縦より
// 十分大きいときだけ反応させる。
(function detailSwipe() {
  const el = $("detail");
  const TABS = ["screen", "log"];
  let x0 = 0, y0 = 0, fromEdge = false, tracking = false;
  el.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1) { tracking = false; return; }
    x0 = e.touches[0].clientX; y0 = e.touches[0].clientY;
    fromEdge = x0 <= 24;               // 画面左端から始まったか
    tracking = true;
  }, { passive: true });
  el.addEventListener("touchend", (e) => {
    if (!tracking) return;
    tracking = false;
    const t = e.changedTouches[0];
    const dx = t.clientX - x0, dy = t.clientY - y0;
    if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 2) return;   // 縦寄りは無視
    if (fromEdge && dx > 0) { closeDetail(); return; }                  // 左端→右で戻る
    const i = TABS.indexOf(dTab);
    // 左フリックで次のタブ、右フリックで前のタブ
    const next = TABS[Math.min(TABS.length - 1, Math.max(0, i + (dx < 0 ? 1 : -1)))];
    if (next !== dTab) setTab(next, true);
  }, { passive: true });
})();

$("dtabs").onclick = (e) => { const d = e.target.closest("[data-t]"); if (d) setTab(d.dataset.t); };
function setTab(tab, force = false) {
  dTab = tab;
  document.querySelectorAll("#dtabs div").forEach(d => d.classList.toggle("on", d.dataset.t === tab));
  $("dscreen").style.display = tab === "screen" ? "" : "none";
  $("dlog").style.display = tab === "log" ? "" : "none";
  const s = sessionOf(openKey);
  if (tab === "log" && s) loadLog(s, force);
  // タブを切り替えたら常に最新(最下部)から見せる
  toBottom(); requestAnimationFrame(toBottom);
}

let logSeq = 0;
async function loadLog(s, force = false) {
  const seq = ++logSeq;
  const d = await fetchTranscript(s, { limit: 60 });
  if (seq !== logSeq || openKey !== s.key) return;   // 切替中の上書きを防ぐ
  const el = $("dlog");
  const stick = force || atBottom();
  el.innerHTML = (d.entries || []).map(e => {
    const text = maskText(e.text ?? "");
    // 思考・ツールはモバイルでは畳まず1行に切り詰める(タップ対象を増やさない)
    const brief = ["thinking", "tool_use", "tool_result"].includes(e.role);
    const body = brief ? esc(text.replace(/\s+/g, " ").slice(0, 120)) : linkify(esc(text));
    return `<div class="entry ${e.role}">${e.ts ? `<span class="ts">${e.ts.slice(11, 16)}</span> ` : ""}${body}</div>`;
  }).join("") || `<div class="empty">ログがありません</div>`;
  if (stick) { toBottom(); requestAnimationFrame(toBottom); }
}

// ---------------- 送信 ----------------
async function send() {
  const s = sessionOf(openKey);
  const text = $("dinput").value.trim();
  if (!s || !text) return;
  if (!canOperate(s)) { toast("実行中のセッションではありません"); return; }
  $("dinput").value = "";
  const r = await sendText(s, text);
  toast((r.result || "").startsWith("ok") ? "送信しました" : "送信に失敗しました");
}
$("dsendbtn").onclick = send;
$("dinput").onkeydown = (e) => {
  if (e.key === "Enter" && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); send(); }
};

// ---------------- 通知(タブが背面でも気づけるように) ----------------
function toast(msg) {
  document.querySelectorAll(".toast").forEach(t => t.remove());
  const t = document.createElement("div");
  t.className = "toast"; t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2200);
}

// ---------------- 起動 ----------------
agd.onSnapshot = (sessions, changes) => {
  $("conn").textContent = readOnly ? "閲覧のみ" : "";
  // 詰まりが増えた瞬間だけ知らせる(監視盤の主目的)
  for (const c of changes) if (c.to === "waiting") toast(`▲ ${c.name} が入力待ちです`);
  // 描画は最短1秒間隔。スクロール中に頻繁に差し替えない
  if (Date.now() - lastRender > 1000 || !$("list").children.length) {
    lastRender = Date.now();
    renderList();
  }
  const s = sessionOf(openKey);
  if (s) paintDetail(s);
};
agd.onDisconnect = () => { $("conn").textContent = "接続待ち…"; };
agd.onMaskChange = renderList;

renderFilters();
loadConfig().then(c => {
  readOnly = !!c.readOnly;
  if (readOnly) {
    // 送信手段を出さない。押せるのに 403 になる状態が一番わかりにくい
    $("dsend").style.display = "none";
    $("conn").textContent = "閲覧のみ";
  }
  connect();
});
