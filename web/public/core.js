// agd 共通ロジック層(ビュー非依存)。
//
// デスクトップ版(app.js)とモバイル版(mobile.js)の両方から読み込まれる。
// ここには「どう見せるか」を持たず、「何を持っていて、どう整形し、どう送るか」だけを置く。
// DOM を触るのは setScreen()/toast() のようにビューから要素を渡されるものに限る。
//
// ビュー側が用意するもの:
//   agd.onSnapshot(sessions, changes)  スナップショット受信時に呼ばれる
//   agd.onDisconnect()                 切断時(任意)
//   agd.onMaskChange()                 マスク切替時の再描画(任意)

const agd = {
  sessions: [],
  pathStrip: "",
  assetVersion: null,
  onSnapshot: null,
  onDisconnect: null,
  onMaskChange: null,
};

// ---------------- 整形 ----------------
function fmtAge(s) {
  if (s < 60) return s + "s"; if (s < 3600) return Math.floor(s / 60) + "m";
  if (s < 86400) return Math.floor(s / 3600) + "h"; return Math.floor(s / 86400) + "d";
}
function shortCwd(c) {
  let s = c || "";
  if (agd.pathStrip && s.startsWith(agd.pathStrip)) s = "…" + s.slice(agd.pathStrip.length);
  return maskText(s.replace(/^\/Users\/[^/]+/, "~").replace(/^\/home\/[^/]+/, "~"));
}
// 本文用。< と & だけ潰せば要素の外には出られない
function esc(t) { return (t ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;"); }
// 属性値用。端末画面やセッション名など外部由来の文字列を title="..." や
// data-* に入れる場合は必ずこちらを使う。esc() は " を残すため、
// 属性を抜け出して別の属性(onerror= など)を注入できてしまう。
function escAttr(t) {
  return (t ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
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

// ---------------- マスクモード(スクリーンショット用) ----------------
// 決定的スクランブル: 英字→英字・数字→数字・CJK→ダミー漢字。空白/記号/罫線は保持するので
// レイアウトと ANSI カラーはそのまま、内容だけが読めなくなる。
let maskMode = localStorage.getItem("agd-mask") === "1";
const MASK_CJK = ["内", "容", "秘", "匿", "伏", "字", "例", "文", "何", "処"];
function maskText(t) {
  if (!maskMode || !t) return t;
  let out = "";
  for (const ch of t) {
    const c = ch.codePointAt(0);
    if (c >= 97 && c <= 122) out = out + String.fromCharCode(97 + (c * 7 + 3) % 26);        // a-z
    else if (c >= 65 && c <= 90) out = out + String.fromCharCode(65 + (c * 7 + 3) % 26);    // A-Z
    else if (c >= 48 && c <= 57) out = out + String.fromCharCode(48 + (c * 7 + 3) % 10);    // 0-9
    else if (c >= 0x3040) out = out + MASK_CJK[c % MASK_CJK.length];                        // かな・漢字等
    else out = out + ch;                                                                     // 空白・記号・罫線
  }
  return out;
}
function isMasked() { return maskMode; }
function toggleMask() {
  maskMode = !maskMode;
  localStorage.setItem("agd-mask", maskMode ? "1" : "0");
  document.querySelectorAll(".screen").forEach(el => delete el.dataset.raw);  // 画面キャッシュ無効化
  agd.onMaskChange?.();
  return maskMode;
}

// エスケープ済みテキスト内の URL をリンク化(新しいタブで開く)。末尾の句読点や括弧は除外
function linkify(escaped) {
  // 日本語(かな・漢字・全角記号)はURL境界とみなして打ち切る
  return escaped.replace(/(https?:\/\/[^\s<>"'　-ヿ一-鿿＀-￯]+)/g, (m) => {
    // 末尾の句読点・括弧・Markdown記号(** など)はURLに含めない
    const url = m.replace(/[)\]}.,;:。、」』>*_`]+$/, "");
    return `<a href="${url}" target="_blank" rel="noopener">${url}</a>${m.slice(url.length)}`;
  });
}

// ---------------- ANSI カラー → HTML ----------------
const ANSI_FG = { 30:"#484f58",31:"#ff7b72",32:"#3fb950",33:"#d29922",34:"#58a6ff",35:"#bc8cff",36:"#39c5cf",37:"#b1bac4",90:"#6e7681",91:"#ffa198",92:"#56d364",93:"#e3b341",94:"#79c0ff",95:"#d2a8ff",96:"#56d4dd",97:"#f0f6fc" };
function c256(n) { // xterm 256色 → rgb
  if (n < 16) return ANSI_FG[n < 8 ? 30 + n : 90 + n - 8] ?? "#b1bac4";
  if (n < 232) {
    const v = [0, 95, 135, 175, 215, 255];
    const i = n - 16;
    return `rgb(${v[Math.floor(i / 36)]},${v[Math.floor(i / 6) % 6]},${v[i % 6]})`;
  }
  const g = 8 + (n - 232) * 10;
  return `rgb(${g},${g},${g})`;
}
function ansiToHtml(raw) {
  // SGR(\x1b[..m)以外の制御シーケンスは除去してからエスケープ
  const cleaned = raw
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "")      // OSC
    .replace(/\x1b\[[0-9;?]*[A-LN-Za-ln-z]/g, "")          // SGR(m)以外のCSI
    .replace(/\x1b[^\[]/g, "");
  const st = { fg: null, bg: null, bold: false };
  let out = "", openSpan = false;
  const flushStyle = () => {
    if (openSpan) { out += "</span>"; openSpan = false; }
    const css = [];
    if (st.fg) css.push(`color:${st.fg}`);
    if (st.bg) css.push(`background:${st.bg}`);
    if (st.bold) css.push("font-weight:bold");
    if (css.length) { out += `<span style="${css.join(";")}">`; openSpan = true; }
  };
  const parts = cleaned.split(/\x1b\[([0-9;]*)m/);
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) { out += esc(maskText(parts[i])); continue; }
    const codes = (parts[i] || "0").split(";").map(Number);
    for (let k = 0; k < codes.length; k++) {
      const c = codes[k];
      if (c === 0) { st.fg = st.bg = null; st.bold = false; }
      else if (c === 1) st.bold = true;
      else if (c === 22) st.bold = false;
      else if (c >= 30 && c <= 37 || c >= 90 && c <= 97) st.fg = ANSI_FG[c];
      else if (c === 39) st.fg = null;
      else if (c >= 40 && c <= 47) st.bg = ANSI_FG[c - 10];
      else if (c >= 100 && c <= 107) st.bg = ANSI_FG[c - 10];
      else if (c === 49) st.bg = null;
      else if (c === 38 || c === 48) {
        const isFg = c === 38;
        if (codes[k + 1] === 5) { const col = c256(codes[k + 2] ?? 0); isFg ? st.fg = col : st.bg = col; k += 2; }
        else if (codes[k + 1] === 2) { const col = `rgb(${codes[k+2]??0},${codes[k+3]??0},${codes[k+4]??0})`; isFg ? st.fg = col : st.bg = col; k += 4; }
      }
    }
    flushStyle();
  }
  if (openSpan) out += "</span>";
  return out;
}
// 差分が無ければ描き直さない(スクロール位置と選択を保つ)。
// 描き直す場合も横位置は復元する。innerHTML の入れ替えで scrollLeft が 0 に
// 戻るため、横に送って読んでいる最中に再描画が走ると先頭へ飛んでしまう。
function setScreen(el, raw) {
  if (el.dataset.raw === raw) return false;
  const sx = el.scrollLeft;
  el.dataset.raw = raw;
  el.innerHTML = ansiToHtml(raw);
  if (sx) el.scrollLeft = sx;
  return true;
}

// ---------------- セッション ----------------
function sessionOf(key) { return agd.sessions.find(x => x.key === key); }
// 操作先の識別。ローカルは tty、リモート(ssh+tmux)は remote を持つ。
// tty が無い＝操作不能ではないので、判定は必ずこれを通す。
const canOperate = (s) => !!s && !!s.running && (!!s.tty || !!s.remote);
// API に渡す宛先。サーバー側は cardKey があれば remote を優先解決する
const target = (s) => ({ tty: s?.tty ?? "", cardKey: s?.key ?? "" });

// ---------------- API ----------------
async function api(path, body) {
  const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return r.json();
}
async function fetchTranscript(s, params = {}) {
  const q = new URLSearchParams({ agent: s.agent, sid: s.sid, ...params });
  const r = await fetch(`/api/transcript?${q}`);
  return r.json();
}
// セッションへの操作。ビューはこれを呼ぶだけでよい(ローカル/リモートの差は core が吸収)
const sendText = (s, text) => api("/api/send", { ...target(s), text });
const sendKey = (s, key) => api("/api/key", { ...target(s), key });
const sendKeys = (s, keys) => api("/api/key", { ...target(s), keys });
const focusSession = (s) => api("/api/focus", s?.remote ? { cardKey: s.key } : { tty: s?.tty ?? "" });
const closeSession = (s) => api("/api/close", { ...target(s) });

// ---------------- 許可プロンプトへの応答 ----------------
// n は 1 始まり。claude の番号型だけが数字キーで直接選べ、それ以外(codex の
// 番号型・両者のカーソル型)は ↑↓ で移動してから Enter で確定する必要がある。
// この差はビューに関係なく同じなので core が持つ。
function answerPrompt(s, n) {
  if (!(s?.status === "waiting" && canOperate(s) && s.prompt)) return null;
  const count = (s.prompt.options ?? []).length;
  if (n < 1 || n > count) return null;
  if (s.prompt.kind === "numbered" && s.agent === "claude") return sendKey(s, String(n));
  const delta = (n - 1) - (s.prompt.cursorIndex ?? 0);
  return sendKeys(s, [...Array(Math.abs(delta)).fill(delta > 0 ? "Down" : "Up"), "Enter"]);
}

// ---------------- WebSocket ----------------
// 再接続と資産バージョン監視は共通。受け取った内容の見せ方だけがビューの仕事。
let reconnectTimer = null;
function connect() {
  // 多重接続を避ける。onclose と onerror の両方から呼ばれても1本に収束させる
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  let ws;
  try { ws = new WebSocket(`ws://${location.host}/ws`); }
  catch { return retry(); }

  ws.onmessage = (ev) => {
    let msg;
    // 壊れたフレームで更新が止まらないよう、パース失敗はその1件だけ捨てる
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type !== "snapshot") return;
    // フロント資産が更新されたら自動で読み直す。agd.app(WKWebView)は
    // 手動リロード手段が限られ、古い JS のまま動き続けると原因が掴みにくい
    if (msg.assetVersion) {
      if (!agd.assetVersion) agd.assetVersion = msg.assetVersion;
      else if (agd.assetVersion !== msg.assetVersion) { location.reload(); return; }
    }
    agd.sessions = msg.sessions || [];
    // 描画side の例外で受信ループを壊さない
    try { agd.onSnapshot?.(agd.sessions, msg.changes || []); }
    catch (e) { console.error("onSnapshot:", e); }
  };
  // onerror だけが飛んで onclose が来ない環境もあるため両方から再接続する
  ws.onerror = () => { try { ws.close(); } catch {} };
  ws.onclose = () => { agd.onDisconnect?.(); retry(); };
}
function retry() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(connect, 2000);
}

// 起動時の設定取得(パス短縮の接頭辞など)
async function loadConfig() {
  try {
    const c = await (await fetch("/api/config")).json();
    agd.pathStrip = c.pathStrip || "";
    return c;
  } catch { return {}; }
}
