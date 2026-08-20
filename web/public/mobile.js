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

// ピン留め。PC版と同じキーを使うので、どちらで留めても両方に反映される
let pinned = [];
try { pinned = JSON.parse(localStorage.getItem("agd-pinned-keys") || "[]"); } catch {}
function togglePin(key) {
  const i = pinned.indexOf(key);
  const s = sessionOf(key);
  if (i >= 0) { pinned.splice(i, 1); toast(t("m.unpinned", { name: maskText(s?.name ?? key) })); }
  else { pinned.push(key); toast(t("m.pinned", { name: maskText(s?.name ?? key) })); }
  try { localStorage.setItem("agd-pinned-keys", JSON.stringify(pinned)); } catch {}
  renderList();
}

// 書きかけの入力(セッションkey → 本文)。戻ってきたら復元する
const DRAFT_KEY = "agd-m-drafts";
let drafts = {};
try { drafts = JSON.parse(localStorage.getItem(DRAFT_KEY) || "{}"); } catch {}
function saveDraft(key, text) {
  if (!key) return;
  if (text) drafts[key] = text; else delete drafts[key];
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify(drafts)); } catch {}
}

// ---------------- 一覧 ----------------
function visible() {
  const q = query.trim().toLowerCase();
  return agd.sessions
    .filter(s => filter.has(s.status))
    .filter(s => !q || `${s.name} ${s.cwd} ${s.summary ?? ""}`.toLowerCase().includes(q))
    // ピン > 詰まっているもの > 新しい順
    .sort((a, b) =>
      (pinned.includes(b.key) ? 1 : 0) - (pinned.includes(a.key) ? 1 : 0)
      || STATUSES.indexOf(a.status) - STATUSES.indexOf(b.status)
      || a.ageS - b.ageS);
}

function renderCounts() {
  const c = { waiting: 0, busy: 0, idle: 0 };
  for (const s of agd.sessions) if (c[s.status] !== undefined) c[s.status]++;
  $("counts").innerHTML =
    `<span class="c-waiting">▲<b>${c.waiting}</b></span>` +
    `<span class="c-busy">●<b>${c.busy}</b></span>` +
    `<span class="c-idle">○<b>${c.idle}</b></span>`;
}

let swiping = false;      // 行スワイプ中は再描画を止める
let swipeAt = 0;          // スワイプを開始した時刻(固着の検知に使う)
let heldRecently = false; // 直前に長押しでメニューを出したか(タップの誤発火を防ぐ)
function renderList() {
  renderCounts();
  // スワイプ中は描き直さない(対象行が別要素になり操作が壊れるため)。
  // ただし触っていないのにフラグが残った場合に備え、時間で強制解除する
  if (swiping) {
    if (Date.now() - swipeAt < 5000) return;
    swiping = false;
    document.querySelectorAll("#list .row.swiping").forEach(r => r.classList.remove("swiping", "armed"));
  }
  // 前回のスワイプで付いたインラインスタイルが残っていると、次の描画で
  // それが引き継がれて他の行まで動いて見えることがある
  document.querySelectorAll("#list .row[style]").forEach(r => r.removeAttribute("style"));
  const list = visible();
  const el = $("list");
  if (!list.length) { el.innerHTML = `<div class="empty">${esc(t("m.empty"))}</div>`; return; }
  el.innerHTML = list.map(s => {
    const host = s.remote ? `<span class="host">${esc(s.remote.host)}</span>` : "";
    // 入力待ちは一覧から直接答えられるようにする(詳細を開かせない)
    const answers = !readOnly && s.status === "waiting" && s.prompt?.options?.length
      ? `<div class="answers">${s.prompt.options.slice(0, 4).map((o, i) =>
          `<button class="abtn" data-k="${escAttr(s.key)}" data-a="${i + 1}">${esc(maskText(o.label)).slice(0, 24)}</button>`).join("")}${
          // 複数選択は数字がチェックの ON/OFF なので、確定用の Enter が別に要る
          s.prompt.multiSelect ? `<button class="abtn confirm" data-k="${escAttr(s.key)}" data-a="enter">${esc(t("prompt.confirm"))}</button>` : ""}</div>`
      : "";
    const isPinned = pinned.includes(s.key);
    return `<div class="row ${s.status}${isPinned ? " pinned" : ""}" data-k="${escAttr(s.key)}"
      data-action="${escAttr(isPinned ? t("m.actionUnpin") : t("m.actionPin"))}">
      <span class="dot ${s.status}"></span>
      <div class="body">
        <div class="line1">
          <span class="proj" style="background:${projColor(s.cwd)}">${esc(projName(s.cwd))}</span>
          <span class="name">${esc(maskText(s.name))}</span>
          ${host}${pinned.includes(s.key) ? '<span class="pin-mark">📌</span>' : ""}<span class="age">${fmtAge(s.ageS)}</span>
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
  // 長押しでメニューを出した直後の click は無視する(詳細が開いてしまうため)
  if (heldRecently) { heldRecently = false; return; }
  if (row) openDetail(row.dataset.k);
};

let answering = false;   // 応答の多重送信を防ぐ
async function answer(s, n) {
  if (answering) return;
  answering = true;
  try {
    // 複数選択の確定(Enter)。数字はチェックの ON/OFF でしかない
    const isConfirm = n === "enter";
    const multi = !!s.prompt?.multiSelect;
    const r = isConfirm ? await sendKey(s, "Enter") : await answerPrompt(s, Number(n));
    // r が null なのは「待機中でない/範囲外」。加えてサーバー側で送れなかった
    // 場合({result:"error: …"})もある。後者を見ていないと、届いていないのに
    // 「送信しました」と出してプロンプトまで畳んでしまっていた
    if (!r || sendFailure(r)) { toastError(t("m.answerFailed")); return; }
    toast(t("m.sent"));
    // 複数選択はチェックを重ねてから確定するので、確定するまで畳んではいけない。
    // 畳むと2つ目以降にチェックを付けられなくなる
    if (multi && !isConfirm) return;
    // 送信済みのプロンプトは即座に畳む。次のポーリングまで残っていると
    // 同じ選択肢をもう一度押せてしまう
    delete s.prompt;
    const cur = sessionOf(s.key);
    if (cur) delete cur.prompt;
    renderList();
    if (openKey === s.key) paintDetail(cur ?? s);
  } catch (e) {
    // 通信断などで送信できなかった場合。黙って固まらせない
    toastError(t("m.answerFailed"));
  } finally {
    answering = false;
  }
}

// ---------------- フィルタ ----------------
function renderFilters() {
  $("filters").innerHTML = STATUSES.map(s =>
    `<span class="chip ${filter.has(s) ? "on" : ""}" data-s="${s}">${
      { waiting: t("m.f.waiting"), busy: t("m.f.busy"), idle: t("m.f.idle"), resumable: t("m.f.resumable") }[s]}</span>`).join("");
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

// 一覧の行を右へスワイプしてピン留め切替。指の動きに行が追従し、左側に
// これから起きるアクション(📌 ピン留め / ピン解除)が現れる。
// 縦スクロールを妨げないよう、横向きと判断できるまでは行を動かさない。
(function listSwipe() {
  const list = $("list");
  const THRESHOLD = 64;          // これ以上で確定
  let row = null, key = null, x0 = 0, y0 = 0, dir = null;
  let holdTimer = null;   // 長押し(起動メニュー)のタイマー
  const cancelHold = () => { clearTimeout(holdTimer); holdTimer = null; };

  const reset = (animate) => {
    if (!row) return;
    if (animate) row.style.transition = "transform .18s";
    row.style.transform = "";
    const r = row, done = () => { r.style.transition = ""; r.classList.remove("swiping", "armed"); };
    animate ? setTimeout(done, 180) : done();
    row = key = dir = null;
  };

  const finish = (fire) => {
    cancelHold();
    if (!row) { swiping = false; return; }
    const fired = fire && dir === "h" && row.classList.contains("armed");
    const k = key;
    row.classList.remove("armed");
    reset(true);
    swiping = false;
    if (fired && k) togglePin(k);      // ここで renderList が走り一覧が最新になる
    else renderList();                 // 止めていた間の更新を反映
  };
  list.addEventListener("touchstart", (e) => {
    reset(false);
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    // ボタン(応答・ピン)を押しているときはスワイプでも長押しでもない
    if (t.target.closest?.("button")) { row = key = null; swiping = false; return; }
    row = t.target.closest?.(".row") ?? null;
    key = row?.dataset.k ?? null;
    x0 = t.clientX; y0 = t.clientY; dir = null;
    swiping = !!row;
    swipeAt = Date.now();
    heldRecently = false;
    cancelHold();
    if (row) holdTimer = setTimeout(() => { heldRecently = true; const k = key; finish(false); openSheet(k); }, 500);
  }, { passive: true });

  list.addEventListener("touchmove", (e) => {
    if (!row || e.touches.length !== 1) return;
    const t = e.touches[0];
    const dx = t.clientX - x0, dy = t.clientY - y0;
    if (Math.abs(dx) > 8 || Math.abs(dy) > 8) cancelHold();
    if (!dir) {
      if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
      dir = Math.abs(dx) > Math.abs(dy) * 1.2 ? "h" : "v";
      if (dir === "h") row.classList.add("swiping");     // 左のアクション欄を見せる
    }
    if (dir !== "h") return;
    // 右方向のみ。行き過ぎは抵抗をつけて止める
    const shift = dx <= 0 ? 0 : dx < THRESHOLD ? dx : THRESHOLD + (dx - THRESHOLD) * 0.3;
    row.style.transform = `translateX(${shift}px)`;
    row.classList.toggle("armed", dx >= THRESHOLD);
  }, { passive: true });

  list.addEventListener("touchend", () => finish(true), { passive: true });
  // 着信やシステムジェスチャで touchend が来ないことがある。ここで解除しないと
  // swiping が立ったままになり、一覧が更新されず古い表示のまま固まる
  list.addEventListener("touchcancel", () => finish(false), { passive: true });
})();


// ---------------- 長押しの起動メニュー ----------------
// 行を長押しすると「このプロジェクトで新規 / 複製」を出す。
// 外側タップ・キャンセル・戻るジェスチャで閉じる。
let sheetKey = null;
function openSheet(key) {
  const s = sessionOf(key);
  if (!s) return;
  sheetKey = key;
  $("sheet-title").textContent = `${projName(s.cwd)} · ${s.agent}`;
  resetKill();                 // 前回の確認待ちを持ち越さない
  $("sheet-bg").classList.add("on");
  if (navigator.vibrate) navigator.vibrate(10);   // 長押しが効いたことを触感で返す
}
function closeSheet() { $("sheet-bg").classList.remove("on"); sheetKey = null; resetKill(); }

// 背景(シート外)のタップで閉じる
$("sheet-bg").onclick = (e) => { if (e.target === $("sheet-bg")) closeSheet(); };
$("sheet-cancel").onclick = closeSheet;

// 新規: 同じプロジェクト・同じエージェントで、まっさらなセッションを立てる
// 複製: 会話を引き継いで別セッションとして分岐する(PC版の Ctrl+C と同じ)
async function launchFrom(key, dup) {
  const s = sessionOf(key);
  if (!s?.cwd) { toastError(t("m.launchFailed")); return; }
  closeSheet();
  let r;
  try {
    // リモートのセッションはそのホスト側で fork/起動する(cwd は母艦に存在しない)
    const cardKey = s.remote ? s.key : "";
    if (dup && s.sid) r = await api("/api/resume", { agent: s.agent, sid: s.sid, cwd: s.cwd, fork: true, cardKey });
    else r = await api("/api/new", { agent: s.agent, cwd: s.cwd, cardKey });
  } catch { toastError(t("m.launchFailed")); return; }
  // 端末を開けなかった場合はサーバーが error を返す(result は無い)
  toast(!r?.error && (r.result || "").startsWith("ok")
    ? t("m.launched", { name: projName(s.cwd) })
    : t("m.launchFailed"));
}
$("sheet-new").onclick = () => launchFrom(sheetKey, false);
$("sheet-dup").onclick = () => launchFrom(sheetKey, true);

// ---------------- 新規セッション(ヘッダーの ＋) ----------------
// 起動先を2つのタブから選ぶ:
//   プロジェクト … これまで使った作業ディレクトリ(/api/projects)
//   セッション   … いま動いている/再開できるセッションの場所
// エージェントは上部の chip で claude ⇄ codex を切り替える(PC版と同じ考え方)
let newTab = "tree";
let newAgent = "claude";
let newProjects = [];
let treeDir = "";        // ツリーでいま開いているディレクトリ(空=ホーム)
let treeKids = [];
let treeHome = "";

function openNewSheet() {
  $("new-bg").classList.add("on");
  paintNewAgent();
  renderNewList();
  // 候補は開くたびに取り直す(新しく使った場所を反映するため)
  apiGet("/api/projects").then(({ projects }) => {
    newProjects = projects ?? [];
    // ホームは /api/projects の先頭に入っている(cwd の共通祖先として必ず含まれる)
    if (!treeHome) treeHome = (projects ?? []).find(p => /^\/(Users|home)\/[^/]+$/.test(p)) ?? "";
    if (!treeDir) treeDir = treeHome;
    if (newTab === "tree") loadTree(treeDir);
    else renderNewList();
  }).catch(() => {});
}
function closeNewSheet() { $("new-bg").classList.remove("on"); }

// ディレクトリを1階層開く。中身は都度取りに行く(数千件のツリーを持たない)
async function loadTree(dir) {
  treeDir = dir;
  treeKids = null;                 // 読み込み中
  renderNewList();
  try {
    const { dirs } = await apiGet(`/api/dirs?browse=1&q=${encodeURIComponent(dir + "/")}`);
    treeKids = dirs ?? [];
  } catch { treeKids = []; }   // 失敗時は空表示(読み込み中のまま固まらせない)
  renderNewList();
}

function renderNewList() {
  const el = $("new-list");
  if (newTab === "tree") {
    if (treeKids === null) { el.innerHTML = `<div class="empty">${esc(t("m.loading"))}</div>`; return; }
    // 先頭は「ここで起動」。辿ってきた場所そのものを選べないと行き止まりになる
    let html = `<div class="nitem here" data-cwd="${escAttr(treeDir)}">
        <span class="np">${esc(t("m.new.launchHere", { name: projName(treeDir) }))}</span>
      </div>`;
    // ホームより上には行かせない(辿る意味が無いうえ迷子になりやすい)
    if (treeDir && treeHome && treeDir !== treeHome) {
      const up = treeDir.slice(0, treeDir.lastIndexOf("/")) || "/";
      html += `<div class="nitem up" data-dir="${escAttr(up)}"><span class="np">↑ ${esc(shortCwd(up))}</span></div>`;
    }
    html += treeKids.map(d =>
      `<div class="nitem" data-dir="${escAttr(d)}">
         <span class="np">📁 ${esc(d.slice(d.lastIndexOf("/") + 1))}</span>
       </div>`).join("");
    el.innerHTML = html;
    el.scrollTop = 0;
    return;
  }
  // 既存のパス一覧。これまで claude/codex を動かした場所
  if (!newProjects.length) { el.innerHTML = `<div class="empty">${esc(t("m.loading"))}</div>`; return; }
  el.innerHTML = newProjects.map(p =>
    `<div class="nitem" data-cwd="${escAttr(p)}">
       <span class="proj" style="background:${projColor(p)}">${esc(projName(p))}</span>
       <span class="np">${esc(shortCwd(p))}</span>
     </div>`).join("");
}

$("btn-new").onclick = openNewSheet;
$("new-close").onclick = closeNewSheet;
$("new-bg").onclick = (e) => { if (e.target === $("new-bg")) closeNewSheet(); };
// トグルの見た目を現在値に合わせる(textContent を書き換えると中の2択が消える)
function paintNewAgent() {
  $("new-agent").querySelectorAll(".opt")
    .forEach(o => o.classList.toggle("on", o.dataset.agent === newAgent));
}
$("new-agent").onclick = (e) => {
  const opt = e.target.closest(".opt");
  // 片方を直接押したらそれを選ぶ。枠の余白なら切り替え
  newAgent = opt ? opt.dataset.agent : (newAgent === "claude" ? "codex" : "claude");
  paintNewAgent();
};
$("new-tabs").onclick = (e) => {
  const tb = e.target.closest(".ntab");
  if (!tb) return;
  newTab = tb.dataset.tab;
  [...$("new-tabs").children].forEach(c => c.classList.toggle("on", c === tb));
  // ツリーへ戻ったときは中身を取り直す(未読込のまま「読み込み中」で止まらないように)
  if (newTab === "tree" && treeKids === null) loadTree(treeDir || treeHome);
  else renderNewList();
};
let newLaunching = false;   // 連打で二重に起動しない
$("new-list").onclick = async (e) => {
  const it = e.target.closest(".nitem");
  if (!it || newLaunching) return;
  // data-dir は「そこへ潜る」、data-cwd は「そこで起動する」
  if (it.dataset.dir) { loadTree(it.dataset.dir); return; }
  newLaunching = true;
  const cwd = it.dataset.cwd;
  closeNewSheet();
  try {
    const r = await api("/api/new", { agent: newAgent, cwd });
    // 端末が開けないと result ではなく error が返る。成功として扱わない
    toast(r?.error ? t("m.launchFailed") : t("m.launched", { name: projName(cwd) }));
  } catch {
    toastError(t("m.launchFailed"));
  } finally { newLaunching = false; }
};

// セッションの終了。取り消せない操作なので、一度目のタップでは実行せず
// 文言と色を変えて確認を求める(スマホは押し間違いが起きやすい)
let killArmed = false;
function resetKill() {
  killArmed = false;
  const b = $("sheet-kill");
  b.classList.remove("armed");
  b.textContent = t("m.killSession");
}
$("sheet-kill").onclick = async () => {
  const s = sessionOf(sheetKey);
  if (!s) return;
  if (!killArmed) {
    killArmed = true;
    const b = $("sheet-kill");
    b.classList.add("armed");
    b.textContent = t("m.killConfirm");
    if (navigator.vibrate) navigator.vibrate(10);
    return;
  }
  const name = maskText(s.name);
  closeSheet();
  try {
    const r = await api("/api/close", { ...target(s), cardKey: s.key });
    toast((r.result || "").startsWith("ok") ? t("m.killed", { name }) : t("m.killFailed"));
  } catch {
    toastError(t("m.killFailed"));
  }
};

// ---------------- 詳細 ----------------
async function openDetail(key) {
  const s = sessionOf(key);
  if (!s) return;
  openKey = key;
  $("detail").classList.add("on");
  document.body.classList.add("detail-open");   // 背後の一覧を奥へ引く
  $("dtitle").innerHTML = esc(maskText(s.name))
    + (s.title ? ` <span class="ai-title">${esc(maskText(s.title))}</span>` : "");
  $("dmeta").textContent = `${shortCwd(s.cwd)} · ${s.status}`;
  $("dinput").value = drafts[key] ?? "";      // 書きかけを復元
  $("ddot").className = `dot ${s.status}`;
  setTab("screen", true);
  paintDetail(s, true);
  logOpen = new Set();          // 別セッションの開閉を持ち越さない
  $("dlog").innerHTML = `<div class="empty">${esc(t("m.loading"))}</div>`;
  await loadLog(s, true);
  clearInterval(logTimer);
  logTimer = setInterval(async () => {
    // 背面に回っている間は更新しない(モバイルの通信とバッテリーを無駄にしない)。
    // 復帰時は visibilitychange で即座に描き直す
    if (document.hidden) return;
    const cur = sessionOf(openKey);
    if (!cur) return;
    paintDetail(cur);
    if (dTab === "log") await loadLog(cur);
  }, 4000);
}
function closeDetail() {
  saveDraft(openKey, $("dinput").value.trim());   // 書きかけを残して戻る
  $("detail").classList.remove("on");
  document.body.classList.remove("detail-open");
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
  // 入力待ちのときは ⏎ の意味が変わる(空欄なら「送信」ではなく「選択の確定」)。
  // 固定文言のままだと、確定できることが画面から読み取れない。
  // placeholder は言語切替で data-i18n-ph から再適用されるため属性ごと差し替える
  const ph = s.status === "waiting" ? "m.sendPhWaiting" : "m.sendPh";
  $("dinput").dataset.i18nPh = ph;
  $("dinput").placeholder = t(ph);
  if (setScreen($("dscreen"), s.screen ?? t("m.screenUnavailable")) && stick) toBottom();
  if (force) toBottom();
  // 入力待ちなら応答ボタンを出す
  const p = s.prompt;
  if (!readOnly && s.status === "waiting" && p?.options?.length) {
    $("dprompt").classList.add("on");
    $("dpq").textContent = maskText(p.question ?? "");
    $("dpa").innerHTML = p.options.map((o, i) =>
      `<button class="abtn" data-a="${i + 1}">${esc(maskText(o.label)).slice(0, 30)}</button>`).join("")
      // 複数選択は数字がチェックの ON/OFF なので、確定用の Enter が別に要る
      + (p.multiSelect ? `<button class="abtn confirm" data-a="enter">${esc(t("prompt.confirm"))}</button>` : "");
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
//
// 端末画面(#dscreen)は原寸維持のため自前で横スクロールする。その上で
// 始まったスワイプは「画面をスクロールしたい」意図なので、タブ切替には
// 使わない。ただし端に張り付いていて、それ以上その向きへスクロールできない
// 場合だけは切替を許す(iOS のページ送りと同じ感覚)。
(function detailSwipe() {
  const el = $("detail");
  const TABS = ["screen", "log"];
  let x0 = 0, y0 = 0, fromEdge = false, tracking = false, scroller = null, sx0 = 0;

  const hScroller = (node) => {
    for (let n = node; n && n !== el; n = n.parentElement) {
      if (n.scrollWidth > n.clientWidth + 2) return n;   // 横スクロールできる祖先
    }
    return null;
  };

  el.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1) { tracking = false; return; }
    const t = e.touches[0];
    x0 = t.clientX; y0 = t.clientY;
    fromEdge = x0 <= 24;
    scroller = hScroller(t.target);
    sx0 = scroller ? scroller.scrollLeft : 0;
    tracking = true;
  }, { passive: true });

  el.addEventListener("touchend", (e) => {
    if (!tracking) return;
    tracking = false;
    const t = e.changedTouches[0];
    const dx = t.clientX - x0, dy = t.clientY - y0;
    // 45px 以上かつ横移動が縦の1.5倍以上。実機では端まで指を滑らせた後に
    // 短くフリックすることが多く、60px/2倍は厳しすぎて反応しなかった。
    if (Math.abs(dx) < 45 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    if (fromEdge && dx > 0) { closeDetail(); return; }                  // 左端→右で戻る
    if (scroller) {
      // 判定は「触り始めた時点で端にいたか」で行う。touchend の scrollLeft は
      // 慣性スクロールでまだ動いている最中のことがあり、端にいても
      // 「スクロールした」と誤判定されるため使わない。
      const max = scroller.scrollWidth - scroller.clientWidth;
      const EPS = 2;
      if (dx < 0 && sx0 < max - EPS) return;   // 左フリック: 開始時に右端でなければスクロール意図
      if (dx > 0 && sx0 > EPS) return;         // 右フリック: 開始時に左端でなければスクロール意図
    }
    const i = TABS.indexOf(dTab);
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
  // タブを切り替えたら常に最新(縦は最下部)を、行頭(横は左端)から見せる。
  // 横位置を戻さないと、前回スクロールした桁のまま表示されて読み始めが分からない
  $("dscreen").scrollLeft = 0;
  toBottom(); requestAnimationFrame(toBottom);
}

let logSeq = 0;
let logOpen = new Set();   // 詳細で開いているログエントリ(index)
async function loadLog(s, force = false) {
  const seq = ++logSeq;
  // 通信断は次の周期で取り直す。表示は前回のまま残す(空になると驚くため)
  let d;
  try { d = await fetchTranscript(s, { limit: 60 }); } catch { return; }
  if (seq !== logSeq || openKey !== s.key) return;   // 切替中の上書きを防ぐ
  const el = $("dlog");
  const stick = force || atBottom();
  // PC版と同じ形式。思考・ツール入力・結果は <details> で畳み、
  // 見出しだけ出す。開いた状態はセッションを開いている間だけ覚える。
  el.innerHTML = (d.entries || []).map((e0, idx) => {
    const e = isMasked() ? { ...e0, text: maskText(e0.text) } : e0;
    const ts = e.ts ? `<span class="ts">${e.ts.slice(11, 16)}</span> ` : "";
    if (e.role === "user") return `<div class="entry user">${ts}${renderMarkdown(e.text)}</div>`;
    if (e.role === "assistant") return `<div class="entry assistant">${ts}${renderMarkdown(e.text)}</div>`;
    const label = e.role === "thinking" ? t("detail.thinking")
      : e.role === "tool_use" ? `🔧 ${esc(e.title ?? "tool")}` : t("detail.result");
    const body = e.role === "tool_use" ? renderToolUse(e) : linkify(esc(e.text));
    return `<div class="entry ${e.role}"><details data-i="${idx}"${logOpen.has(idx) ? " open" : ""}>` +
      `<summary>${ts}${label}</summary><pre>${body}</pre></details></div>`;
  }).join("") || `<div class="empty">${esc(t("m.noLog"))}</div>`;
  // 開閉を覚える(再描画で畳み直さないため)。
  // ontoggle は生成直後にも発火して index がずれるので、summary のクリックで拾う
  el.querySelectorAll("details").forEach(det => {
    const i = Number(det.dataset.i);      // エントリ全体での位置(details だけの連番ではない)
    const sm = det.querySelector("summary");
    if (sm) sm.onclick = () => {
      // クリック直後はまだ open が反転していないので、これから開くかで判断する
      det.open ? logOpen.delete(i) : logOpen.add(i);
    };
  });
  if (stick) { toBottom(); requestAnimationFrame(toBottom); }
}

// ---------------- 送信 ----------------
// 空欄 ⏎ = 選択の確定。誤爆を防ぐため入力待ちのときだけ送る
let confirmBusy = false;
async function confirmEnterMobile(s) {
  if (confirmBusy) return;
  if (s.status !== "waiting") { toast(t("m.notWaiting")); return; }
  confirmBusy = true;
  try {
    const r = await sendKey(s, "Enter");
    const err = sendFailure(r);
    toast(t(err ? "m.sendFailed" : "m.sent"));
  } catch {
    toastError(t("m.sendFailed"));
  } finally { confirmBusy = false; }
}

async function send() {
  const s = sessionOf(openKey);
  const text = $("dinput").value.trim();
  if (!s) return;
  if (!canOperate(s)) { toastError(t("m.notRunning")); return; }
  // 空欄のまま送ったときは素の ⏎ を送る(PC版と同じ)。
  // 選択待ちのプロンプトを確定する手段がこれで、複数選択でチェックを
  // 付けたあとの確定もここを通る。何も起きずに黙って戻ると、
  // 「確定できない」ように見えてしまう
  if (!text) { confirmEnterMobile(s); return; }
  $("dinput").value = "";
  // 通信断で例外が出ると、入力を消したあとで throw して打った内容が消えていた。
  // 電波の悪い場所ほど起きるので、失敗はすべて「本文を戻す」に集約する
  let r;
  try { r = await sendText(s, text); }
  catch { $("dinput").value = text; saveDraft(s.key, text); markSendFailed($("dinput")); toastError(t("m.sendFailed")); return; }
  const err = sendFailure(r);
  if (!err) saveDraft(s.key, "");
  else { $("dinput").value = text; saveDraft(s.key, text); markSendFailed($("dinput")); }   // 失敗時は打ち直させない
  toast(t(err ? "m.sendFailed" : "m.sent"));
}
$("dsendbtn").onclick = send;
$("dinput").oninput = () => saveDraft(openKey, $("dinput").value.trim());
$("dinput").onkeydown = (e) => {
  if (e.key === "Enter" && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); send(); }
};

// ---------------- 通知(タブが背面でも気づけるように) ----------------
// toast() は core.js に移動(PC版と実装が分かれていたため)

// ---------------- 起動 ----------------
agd.onSnapshot = (sessions, changes) => {
  // 接続できていれば何も出さない。閲覧のみのときだけ灰色の点
  $("conn").className = readOnly ? "readonly" : "";
  $("conn").title = readOnly ? t("m.readOnly") : "";
  // 詰まりが増えた瞬間だけ知らせる(監視盤の主目的)
  for (const c of changes) if (c.to === "waiting") toast(t("m.needsInput", { name: c.name }));
  // 描画は最短1秒間隔。スクロール中に頻繁に差し替えない
  if (Date.now() - lastRender > 1000 || !$("list").children.length) {
    lastRender = Date.now();
    renderList();
  }
  const s = sessionOf(openKey);
  if (s) paintDetail(s);
};
agd.onDisconnect = () => {
  $("conn").className = "offline";        // 赤く点滅させて切断を知らせる
  $("conn").title = t("m.connecting");
};
// 前面に戻ったら止めていた分を取り戻す
document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  // 背面に回っている間に指を離した場合、touchend が来ないことがある
  swiping = false;
  document.querySelectorAll("#list .row[style]").forEach(r => r.removeAttribute("style"));
  renderList();
  const s = sessionOf(openKey);
  if (s) { paintDetail(s); if (dTab === "log") loadLog(s); }
});
agd.onMaskChange = renderList;

applyStaticI18n();   // HTML 側の静的文言を現在の言語に差し替える
renderFilters();
loadConfig().then(c => {
  readOnly = !!c.readOnly;
  if (readOnly) {
    // 送信手段を出さない。押せるのに 403 になる状態が一番わかりにくい
    $("dsend").style.display = "none";
    $("btn-new").style.display = "none";   // 新規起動も同じ理由で隠す
    $("conn").className = "readonly";
    $("conn").title = t("m.readOnly");
  }
  connect();
});
