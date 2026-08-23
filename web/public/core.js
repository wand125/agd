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
  if (agd.pathStrip && s.startsWith(agd.pathStrip)) {
    const rest = s.slice(agd.pathStrip.length);
    // 共通プレフィックスちょうどのディレクトリだと rest が空になり、表示が
    // 「…」の1文字だけになってどのセッションか分からなくなる。
    // その場合は末尾のディレクトリ名を残す(…/0_Group)
    s = rest ? "…" + rest : "…/" + (agd.pathStrip.split("/").filter(Boolean).pop() ?? "");
  }
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
// 末尾のディレクトリ名を除いたパス。セッション行では末尾を projName の
// チップで既に出しているため、そのまま shortCwd を並べると同じ語が2回出る
// (実データで8件中7件が重複していた)。親までを出せば「どこにあるか」だけを
// 足せる。親が無い場合は空文字を返す(呼び出し側で出し分ける)
function parentCwd(cwd) {
  const s = shortCwd(cwd);
  const name = projName(cwd);
  if (s === name) return "";
  return s.endsWith("/" + name) ? s.slice(0, -(name.length + 1)) : s;
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


// ---------------- Markdown(会話ログ用の最小実装) ----------------
// claude/codex の応答は Markdown で返ることが多い。外部ライブラリを足さずに
// よく出る記法だけを扱う。入力は必ず esc() 済みの文字列を渡すこと
// (この関数は自分でエスケープしない = 二重エスケープを避けるため)。
function mdInline(escaped) {
  return linkify(escaped)
    // `code` は最初に処理する。中の記号を装飾として解釈させない
    .replace(/`([^`\n]+)`/g, (_, c) => `<code>${c}</code>`)
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,、。]|$)/g, "$1<em>$2</em>")
    .replace(/~~([^~\n]+)~~/g, "<del>$1</del>");
}

// 行単位で見出し・箇条書き・コードブロックを組み立てる。
// 未対応の記法はそのまま文字として残す(壊すより読めるほうがよい)。
function renderMarkdown(text) {
  const lines = esc(text ?? "").split("\n");
  const out = [];
  let list = null;        // "ul" | "ol" | null
  let fence = null;       // コードブロック中の言語名(``` の内側)
  let buf = [];           // コードブロックの中身

  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  const openList = (kind) => {
    if (list === kind) return;
    closeList();
    out.push(`<${kind}>`);
    list = kind;
  };

  // | で始まり | で終わる行。セル内の \| は列区切りとみなさない
  const isRow = (l) => /^\s*\|.*\|\s*$/.test(l);
  // |---|:--:|---| のような区切り行。ここで列の寄せも決まる
  const alignsOf = (l) => /^\s*\|[\s:|-]+\|\s*$/.test(l)
    ? l.trim().slice(1, -1).split("|").map(c => {
        const t = c.trim();
        return t.startsWith(":") && t.endsWith(":") ? "center" : t.endsWith(":") ? "right" : "left";
      })
    : null;
  const cellsOf = (l) => l.trim().slice(1, -1).split(/(?<!\\)\|/).map(c => mdInline(c.trim().replace(/\\\|/g, "|")));

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    // ---- 表 ----
    if (fence === null && isRow(line)) {
      const aligns = alignsOf(lines[li + 1] ?? "");
      if (aligns) {
        closeList();
        const head = cellsOf(line);
        const body = [];
        let n = li + 2;
        while (n < lines.length && isRow(lines[n])) { body.push(cellsOf(lines[n])); n++; }
        const th = head.map((c, i) => `<th style="text-align:${aligns[i] ?? "left"}">${c}</th>`).join("");
        const tr = body.map(cs =>
          `<tr>${cs.map((c, i) => `<td style="text-align:${aligns[i] ?? "left"}">${c}</td>`).join("")}</tr>`).join("");
        out.push(`<div class="md-table-wrap"><table class="md-table"><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table></div>`);
        li = n - 1;
        continue;
      }
    }
    const fenceM = line.match(/^\s*```(\w*)\s*$/);
    if (fenceM) {
      if (fence === null) { closeList(); fence = fenceM[1] || ""; buf = []; }
      else { out.push(`<pre class="md-code"><code>${buf.join("\n")}</code></pre>`); fence = null; }
      continue;
    }
    if (fence !== null) { buf.push(line); continue; }

    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) { closeList(); out.push(`<div class="md-h md-h${h[1].length}">${mdInline(h[2])}</div>`); continue; }
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) { closeList(); out.push('<hr class="md-hr">'); continue; }

    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    if (ul) { openList("ul"); out.push(`<li>${mdInline(ul[1])}</li>`); continue; }
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ol) { openList("ol"); out.push(`<li>${mdInline(ol[1])}</li>`); continue; }

    const quote = line.match(/^\s*&gt;\s?(.*)$/);   // esc 済みなので > は &gt;
    if (quote) { closeList(); out.push(`<div class="md-quote">${mdInline(quote[1])}</div>`); continue; }

    closeList();
    out.push(line.trim() === "" ? "" : mdInline(line));
  }
  if (fence !== null) out.push(`<pre class="md-code"><code>${buf.join("\n")}</code></pre>`);
  closeList();
  // white-space: pre-wrap なので、ブロック要素の前後に残った空行がそのまま
  // 余白になってしまう。隣がブロックなら空行を落とす
  const isBlock = (x) => /^<(div|ul|ol|pre|hr|table)/.test(x || "");
  const cleaned = out.filter((x, i) =>
    !(x === "" && (isBlock(out[i - 1]) || isBlock(out[i + 1]))));
  return cleaned.join("\n");
}

// ---------------- ツール入力の整形 ----------------
// Edit/Write は diff として、Bash はコマンドとして見せる。両ビューで共用する。
// s(セッション)を渡すと、SendUserFile をファイルカードとして描ける。
// 省略した場合は従来どおり(カードにはしない)

// SendUserFile のカード。画像は実物を出し、それ以外はアイコンと名前だけ出す。
// 実体は /api/file から取る(トランスクリプトに出てきたパスだけが通る)
const IMG_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i;
// 動画・音声はブラウザで再生できる。ダウンロードして別アプリで開くより、
// その場で確認できたほうが早い(録画を確認する用途が実際に多い)
const VID_EXT = /\.(mp4|webm|mov|m4v)$/i;
const AUD_EXT = /\.(mp3|wav|m4a|aac|ogg)$/i;
function renderFileCards(obj, s) {
  const caption = typeof obj.caption === "string" ? obj.caption : "";
  const cards = obj.files.filter(f => typeof f === "string").slice(0, 8).map(f => {
    const name = f.slice(f.lastIndexOf("/") + 1);
    const q = `agent=${encodeURIComponent(s.agent)}&sid=${encodeURIComponent(s.sid)}&path=${encodeURIComponent(f)}`;
    const dl = `<a class="fc-dl" href="/api/file?${q}&dl=1" download="${escAttr(name)}">${esc(t("file.download"))}</a>`;
    const foot = `<div class="fc-foot"><span class="fc-name" title="${escAttr(f)}">${esc(maskText(name))}</span>${dl}</div>`;
    if (IMG_EXT.test(f))
      return `<div class="filecard">
        <a href="/api/file?${q}" target="_blank" rel="noopener"><img src="/api/file?${q}" alt="${escAttr(name)}" loading="lazy"></a>
        ${foot}
      </div>`;
    // preload="metadata" にして、開いただけで本体を落とさないようにする
    if (VID_EXT.test(f))
      return `<div class="filecard"><video src="/api/file?${q}" controls preload="metadata" playsinline></video>${foot}</div>`;
    if (AUD_EXT.test(f))
      return `<div class="filecard"><audio src="/api/file?${q}" controls preload="metadata"></audio>${foot}</div>`;
    return `<div class="filecard">
      <div class="fc-foot"><span class="fc-ico">📄</span><span class="fc-name" title="${escAttr(f)}">${esc(maskText(name))}</span>${dl}</div>
    </div>`;
  }).join("");
  return `${caption ? `<div class="fc-caption">${esc(maskText(caption))}</div>` : ""}${cards}`;
}

function renderToolUse(e, s) {
  let obj = null;
  try { obj = JSON.parse(e.text); } catch {}
  if (obj && typeof obj === "object") {
    // ファイル送信。生の JSON を出しても読めないので、名前・説明・
    // サムネイル・ダウンロードを持つカードにする
    if (e.title === "SendUserFile" && Array.isArray(obj.files) && s?.sid) return renderFileCards(obj, s);
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

// ---------------- セッション ----------------
function sessionOf(key) { return agd.sessions.find(x => x.key === key); }
// 操作先の識別。ローカルは tty、リモート(ssh+tmux)は remote を持つ。
// tty が無い＝操作不能ではないので、判定は必ずこれを通す。
const canOperate = (s) => !!s && !!s.running && (!!s.tty || !!s.remote);
// API に渡す宛先。サーバー側は cardKey があれば remote を優先解決する
const target = (s) => ({ tty: s?.tty ?? "", cardKey: s?.key ?? "" });

// ---------------- API ----------------
// GET 用。素の fetch は待ち時間に上限が無く、電波が切れかけていると
// 応答も失敗も返らないまま止まる(「読み込み中」から進まなくなる)。
// 呼び元は例外として受け取り、それぞれの表示に落とす
async function apiGet(path, timeoutMs = 15000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(path, { signal: ac.signal });
    return await r.json();
  } finally { clearTimeout(timer); }
}

async function api(path, body, timeoutMs = 15000) {
  // 応答が返らないまま待ち続けると、送信中フラグが解除されず操作不能になる。
  // 必ず上限を設けて中断する(呼び元は例外として受け取る)
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(path, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: ac.signal,
    });
    return await r.json();
  } finally { clearTimeout(timer); }
}
async function fetchTranscript(s, params = {}) {
  const q = new URLSearchParams({ agent: s.agent, sid: s.sid, ...params });
  // 詳細画面は3秒ごとにこれを呼ぶ。上限が無いと、電波が細いときに応答待ちの
  // リクエストが積み上がって復帰後にまとめて流れ込む
  return apiGet(`/api/transcript?${q}`);
}
// 送信系の応答を判定する。失敗の返り方が2通りあるため、呼び元ごとに
// 書くと片方を取りこぼす:
//   {result:"error: …"}  … 端末へは届いたが送れなかった(HTTP 200)
//   {error:"…"}          … リクエストが弾かれた(400 など)
// 後者を見ていないと「送信に失敗: undefined」という中身の無い表示になる
function sendFailure(r) {
  if (r?.error) return String(r.error);
  const res = String(r?.result ?? "");
  if (res.startsWith("ok")) return null;          // 成功
  return res || "no response";                    // result が空のときも失敗として扱う
}

// セッションへの操作。ビューはこれを呼ぶだけでよい(ローカル/リモートの差は core が吸収)
const sendText = (s, text) => api("/api/send", { ...target(s), text });
const sendKey = (s, key) => api("/api/key", { ...target(s), key });
const sendKeys = (s, keys) => api("/api/key", { ...target(s), keys });
const focusSession = (s) => api("/api/focus", s?.remote ? { cardKey: s.key } : { tty: s?.tty ?? "" });
const closeSession = (s) => api("/api/close", { ...target(s) });

// ---------------- トースト ----------------
// 画面下に一時表示する通知。body に挿すだけでビュー固有の要素を要さないので
// 共通層に置く(以前は PC/モバイルで別実装になっており、表示時間が
// 2500ms と 2200ms に食い違っていた)
let toastTimer = null;
// kind: "error" を渡すと赤く出し、表示時間も長くする。
// 成功と失敗が同じ見た目・同じ2.5秒だったため、PC の大きい画面では隅で
// 一瞬光って消えるだけになり、送れていないことに気づけなかった
function toast(msg, kind) {
  document.querySelectorAll(".toast").forEach(t => t.remove());
  const el = document.createElement("div");
  el.className = "toast" + (kind === "error" ? " error" : "");
  el.textContent = msg;
  document.body.appendChild(el);
  // 前回のタイマーを止めないと、古い timeout が新しいトーストを消してしまう
  clearTimeout(toastTimer);
  // 失敗は読む必要がある(何が起きたか・打ち直しが要るか)ので長めに出す
  toastTimer = setTimeout(() => el.remove(), kind === "error" ? 6000 : 2500);
}
// 失敗表示の入口を1つにする。呼び元が kind を渡し忘れる事故を防ぐ
function toastError(msg) { toast(msg, "error"); }

// 送信に失敗した入力欄を目立たせる。トーストは画面の隅に出るので、
// 大きいディスプレイでは見落としやすい。本文が戻っている欄そのものを
// 赤くして「送れていない・ここに残っている」を示す
function markSendFailed(el) {
  if (!el) return;
  el.classList.add("send-failed");
  const clear = () => el.classList.remove("send-failed");
  el.addEventListener("input", clear, { once: true });
  setTimeout(clear, 6000);
}

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
  const move = Array(Math.abs(delta)).fill(delta > 0 ? "Down" : "Up");
  // フォームは「選んで確定」ではなく「その行に移動して切り替える」。行ごとに
  // 確定キーが違うので、Enter を一律に送るとチェックの切り替えのつもりで
  // フォーム全体を送信してしまう
  if (s.prompt.kind === "form") {
    const label = s.prompt.options[n - 1]?.label ?? "";
    if (/(◀|▶)/.test(label)) return sendKeys(s, [...move, "Right"]);   // ◀ 値 ▶ は左右で切り替え
    if (/\[[ xX✔✓*]\]/.test(label)) return sendKeys(s, [...move, "Space"]); // チェックボックスは Space
    return sendKeys(s, [...move, "Enter"]);                            // Continue などの確定ボタン
  }
  return sendKeys(s, [...move, "Enter"]);
}

// ---------------- WebSocket ----------------
// 再接続と資産バージョン監視は共通。受け取った内容の見せ方だけがビューの仕事。
let reconnectTimer = null;
let retryDelay = 2000;    // 失敗が続くほど間隔を伸ばす(下の retry 参照)
let aliveTimer = null;    // 受信途絶の監視

// サーバーは POLL_MS(2.5秒)ごとに必ずスナップショットを送る。つまり
// 一定時間なにも来ない = 経路が死んでいる、と判断してよい。
// モバイル回線やトンネル経由だと FIN が届かず onclose が飛ばないまま
// 「繋がっているつもり」で古い画面を見続けることがあるため、
// 受信が途絶えたら自分から張り直す
const ALIVE_MS = 15000;
function bumpAlive(ws) {
  clearTimeout(aliveTimer);
  aliveTimer = setTimeout(() => {
    // close を呼べば onclose 経由で切断表示と再接続に入る
    try { ws.close(); } catch {}
  }, ALIVE_MS);
}

function connect() {
  // 多重接続を避ける。onclose と onerror の両方から呼ばれても1本に収束させる
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  let ws;
  try { ws = new WebSocket(`ws://${location.host}/ws`); }
  catch { return retry(); }
  bumpAlive(ws);

  ws.onmessage = (ev) => {
    bumpAlive(ws);            // 何か届いている限り生きているとみなす
    retryDelay = 2000;        // 繋がったので間隔を戻す
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
  ws.onclose = () => { clearTimeout(aliveTimer); agd.onDisconnect?.(); retry(); };
}
function retry() {
  if (reconnectTimer) return;
  // サーバーが落ちている間ずっと2秒間隔で叩き続けると、端末のバッテリーと
  // 回線を無駄に使う。指数的に伸ばし、上限は30秒(復帰の待ち時間として許容できる範囲)
  reconnectTimer = setTimeout(connect, retryDelay);
  retryDelay = Math.min(retryDelay * 2, 30000);
  // 画面に戻ってきた/回線が復活したときは、待たずにすぐ試す
  scheduleImmediateRetry();
}

// visibilitychange と online は「今なら繋がる可能性が高い」合図。
// バックオフの待機中でも即座に張り直す(スマホでアプリを開き直したとき、
// 最大30秒画面が固まったままになるのを防ぐ)
let immediateHooked = false;
function scheduleImmediateRetry() {
  if (immediateHooked) return;
  immediateHooked = true;
  const kick = () => {
    if (document.hidden) return;
    retryDelay = 2000;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; connect(); }
  };
  addEventListener("visibilitychange", kick);
  addEventListener("online", kick);
}

// 起動時の設定取得(パス短縮の接頭辞など)
async function loadConfig() {
  try {
    const c = await (await fetch("/api/config")).json();
    agd.pathStrip = c.pathStrip || "";
    return c;
  } catch { return {}; }
}
