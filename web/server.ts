// agd web — AI Agent Session Dashboard server (Bun)
// 実行中の Claude Code / Codex セッションの一覧・ライブ画面・ログ閲覧・入力送信・通知を
// ブラウザに提供する。起動: bun run server.ts (デフォルト http://localhost:8787)
import { readdirSync, statSync, existsSync, readFileSync, openSync, readSync, closeSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const PORT = Number(process.env.AGD_PORT || 8787);
const HOME = homedir();
const CODEX_SESSIONS = join(HOME, ".codex", "sessions");
const CODEX_INDEX = join(HOME, ".codex", "session_index.jsonl");
const CLAUDE_PROJECTS = join(HOME, ".claude", "projects");
const CLAUDE_HISTORY = join(HOME, ".claude", "history.jsonl");
const POLL_MS = 2500;
const BUSY_WINDOW_S = 20;
const RECENT_LIMIT = 10;

// ---------------------------------------------------------------- 共通ユーティリティ
async function sh(cmd: string[], input?: string): Promise<string> {
  try {
    const p = Bun.spawn(cmd, { stdin: input ? new TextEncoder().encode(input) : undefined, stderr: "ignore" });
    const out = await new Response(p.stdout).text();
    await p.exited;
    return out;
  } catch {
    return "";
  }
}

async function osascript(script: string, args: string[] = []): Promise<string> {
  return sh(["osascript", "-e", script, ...args]);
}

// ---------------------------------------------------------------- rollout メタキャッシュ
type RolloutMeta = { path: string; id: string; cwd: string; mtime: number };
const rolloutCache = new Map<string, RolloutMeta>(); // path → meta
let lastRolloutScan = 0;

function listRolloutFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: string[] = [];
    try { entries = readdirSync(dir); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e);
      let st; try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p);
      else if (e.endsWith(".jsonl")) out.push(p);
    }
  };
  walk(CODEX_SESSIONS);
  return out;
}

async function updateRolloutCache() {
  const files = listRolloutFiles();
  for (const p of files) {
    let st; try { st = statSync(p); } catch { continue; }
    const cached = rolloutCache.get(p);
    if (cached) { cached.mtime = st.mtimeMs / 1000; continue; }
    if (rolloutCache.size > 0 && st.mtimeMs < lastRolloutScan - 60_000 && lastRolloutScan > 0) continue;
    // 先頭行のみ読む
    try {
      // 先頭行は base_instructions を含み数百KBになりうる
      const fh = Bun.file(p);
      const head = await fh.slice(0, 1_000_000).text();
      const line = head.split("\n")[0];
      const meta = JSON.parse(line);
      rolloutCache.set(p, {
        path: p,
        id: meta?.payload?.id ?? "",
        cwd: meta?.payload?.cwd ?? "",
        mtime: st.mtimeMs / 1000,
      });
    } catch { /* 不完全な行は無視 */ }
  }
  lastRolloutScan = Date.now();
}

function rolloutByCwd(cwd: string): RolloutMeta | undefined {
  let best: RolloutMeta | undefined;
  for (const m of rolloutCache.values())
    if (m.cwd === cwd && (!best || m.mtime > best.mtime)) best = m;
  return best;
}
function rolloutById(id: string): RolloutMeta | undefined {
  for (const m of rolloutCache.values()) if (m.id === id) return m;
  return undefined;
}

// ---------------------------------------------------------------- codex セッション名
let codexNames = new Map<string, string>();
function loadCodexNames() {
  if (!existsSync(CODEX_INDEX)) return;
  try {
    const lines = readFileSync(CODEX_INDEX, "utf8").trim().split("\n").slice(-200);
    for (const l of lines) {
      try {
        const o = JSON.parse(l);
        if (o.id && o.thread_name) codexNames.set(o.id, o.thread_name);
      } catch {}
    }
  } catch {}
}

// ---------------------------------------------------------------- セッション収集
export type PromptInfo = {
  question?: string;
  options: { key: string; label: string }[];
  kind?: "numbered" | "cursor";   // cursor: 矢印+Enterで選ぶ形式
  cursorIndex?: number;           // cursor形式での現在選択位置
};
export type GitInfo = { branch: string; dirty: number; ahead: number; behind: number };
export type Session = {
  key: string;            // agent:sid
  agent: "claude" | "codex";
  sid: string;
  name: string;
  cwd: string;
  status: string;         // busy | waiting | idle | resumable
  running: boolean;
  tty: string;            // ttysNNN ("" なら不明)
  pid?: number;
  ageS: number;           // 最終アクティビティからの秒数(概算)
  prompt?: PromptInfo;    // 画面から検出した選択プロンプト
  git?: GitInfo;
};

async function claudeRunning(): Promise<Session[]> {
  const out = await sh(["claude", "agents", "--json"]);
  let arr: any[] = [];
  try { arr = JSON.parse(out); } catch { return []; }
  if (!arr.length) return [];
  const pids = arr.map(a => a.pid).join(",");
  const psOut = await sh(["ps", "-o", "pid=,tty=", "-p", pids]);
  const ttyByPid = new Map<number, string>();
  for (const l of psOut.trim().split("\n")) {
    const m = l.trim().match(/^(\d+)\s+(\S+)/);
    if (m) ttyByPid.set(Number(m[1]), m[2] === "??" ? "" : m[2]);
  }
  return arr.map(a => {
    let status: string = a.status ?? "idle";
    if (/wait|input|need/i.test(status)) status = "waiting";
    return {
      key: `claude:${a.sessionId}`,
      agent: "claude" as const,
      sid: a.sessionId,
      name: a.name || a.sessionId,
      cwd: a.cwd,
      status,
      running: true,
      tty: ttyByPid.get(a.pid) ?? "",
      pid: a.pid,
      ageS: Math.max(0, Math.floor((Date.now() - a.startedAt) / 1000)),
    };
  });
}

async function codexRunning(): Promise<Session[]> {
  const psOut = await sh(["ps", "-axo", "pid=,tty=,command="]);
  const procs: { pid: number; tty: string }[] = [];
  for (const l of psOut.split("\n")) {
    const m = l.trim().match(/^(\d+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    if (/^codex( |$)/.test(m[3])) procs.push({ pid: Number(m[1]), tty: m[2] === "??" ? "" : m[2] });
  }
  if (!procs.length) return [];
  const lsofOut = await sh(["lsof", "-a", "-p", procs.map(p => p.pid).join(","), "-d", "cwd", "-Fpn"]);
  const cwdByPid = new Map<number, string>();
  let cur = 0;
  for (const l of lsofOut.split("\n")) {
    if (l.startsWith("p")) cur = Number(l.slice(1));
    else if (l.startsWith("n")) cwdByPid.set(cur, l.slice(1));
  }
  const now = Date.now() / 1000;
  return procs.flatMap(p => {
    const cwd = cwdByPid.get(p.pid);
    if (!cwd) return [];
    const meta = rolloutByCwd(cwd);
    const ageS = meta ? Math.max(0, Math.floor(now - meta.mtime)) : 0;
    return [{
      key: `codex:${meta?.id ?? `pid${p.pid}`}`,
      agent: "codex" as const,
      sid: meta?.id ?? "",
      name: (meta && codexNames.get(meta.id)) || meta?.id || `pid ${p.pid}`,
      cwd,
      status: meta && now - meta.mtime < BUSY_WINDOW_S ? "busy" : "idle",
      running: true,
      tty: p.tty,
      pid: p.pid,
      ageS,
    }];
  });
}

function claudeRecent(excludeSids: Set<string>): Session[] {
  const out: Session[] = [];
  let dirs: string[] = [];
  try { dirs = readdirSync(CLAUDE_PROJECTS); } catch { return []; }
  const candidates: { mtime: number; sid: string; path: string }[] = [];
  for (const d of dirs) {
    const dir = join(CLAUDE_PROJECTS, d);
    let files: string[] = [];
    try { files = readdirSync(dir).filter(f => f.endsWith(".jsonl")); } catch { continue; }
    let best: { mtime: number; sid: string; path: string } | null = null;
    for (const f of files) {
      let st; try { st = statSync(join(dir, f)); } catch { continue; }
      if (!best || st.mtimeMs > best.mtime) best = { mtime: st.mtimeMs, sid: f.replace(/\.jsonl$/, ""), path: join(dir, f) };
    }
    if (best && !excludeSids.has(best.sid)) candidates.push(best);
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  for (const c of candidates.slice(0, RECENT_LIMIT)) {
    // cwd と要約を先頭部分から抽出
    let cwd = "", name = c.sid;
    try {
      const head = readFileSync(c.path, { encoding: "utf8", flag: "r" }).slice(0, 200_000);
      const m = head.match(/"cwd":"([^"]+)"/);
      if (m) cwd = m[1];
      const s = head.match(/"type":"summary".*?"summary":"([^"]+)"/);
      if (s) name = s[1].slice(0, 60);
    } catch {}
    if (!cwd) continue;
    if (name === c.sid) name = historyPrompt(c.sid) || c.sid;
    out.push({
      key: `claude:${c.sid}`, agent: "claude", sid: c.sid, name, cwd,
      status: "resumable", running: false, tty: "",
      ageS: Math.floor((Date.now() - c.mtime) / 1000),
    });
  }
  return out;
}

let historyCache: Map<string, string> | null = null;
function historyPrompt(sid: string): string {
  if (!historyCache) {
    historyCache = new Map();
    try {
      const lines = readFileSync(CLAUDE_HISTORY, "utf8").trim().split("\n");
      for (const l of lines) {
        try { const o = JSON.parse(l); if (o.sessionId && o.display) historyCache.set(o.sessionId, o.display); } catch {}
      }
    } catch {}
  }
  return (historyCache.get(sid) || "").replace(/\n/g, " ").slice(0, 60);
}

function codexRecent(excludeSids: Set<string>): Session[] {
  const metas = [...rolloutCache.values()]
    .filter(m => m.id && m.cwd && !excludeSids.has(m.id))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, RECENT_LIMIT);
  const now = Date.now() / 1000;
  return metas.map(m => ({
    key: `codex:${m.id}`, agent: "codex" as const, sid: m.id,
    name: codexNames.get(m.id) || m.id, cwd: m.cwd,
    status: "resumable", running: false, tty: "",
    ageS: Math.max(0, Math.floor(now - m.mtime)),
  }));
}

// ---------------------------------------------------------------- 画面キャプチャ
type TmuxPane = { tty: string; paneId: string; target: string };
async function tmuxPanes(): Promise<TmuxPane[]> {
  const out = await sh(["tmux", "list-panes", "-a", "-F", "#{pane_tty}\t#{pane_id}\t#{session_name}:#{window_index}.#{pane_index}"]);
  return out.trim().split("\n").filter(Boolean).map(l => {
    const [tty, paneId, target] = l.split("\t");
    return { tty: tty.replace("/dev/", ""), paneId, target };
  });
}

// ---- iTerm2 Python API ヘルパー(色付き画面取得。使えないときは AppleScript にフォールバック) ----
const itermScreens = new Map<string, { text: string; at: number }>();
let itermHelperOk = false;
function startItermHelper(retryMs = 5000) {
  const py = join(import.meta.dir, ".venv", "bin", "python");
  const script = join(import.meta.dir, "iterm_capture.py");
  if (!existsSync(py) || !existsSync(script)) return;
  try {
    const p = Bun.spawn([py, script], { stderr: "ignore" });
    (async () => {
      const reader = p.stdout.getReader();
      const dec = new TextDecoder();
      let buf = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value);
          let nl;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
            try {
              const msg = JSON.parse(line);
              if (msg.type === "screens") {
                itermHelperOk = true;
                const at = Date.now();
                for (const [tty, text] of Object.entries(msg.screens))
                  itermScreens.set(tty, { text: text as string, at });
              } else if (msg.type === "status") {
                itermHelperOk = !!msg.ok;
                if (!msg.ok) console.error("iterm2 helper:", msg.error);
                else console.log("iterm2 helper: connected (color capture on)");
              }
            } catch {}
          }
        }
      } catch {}
      await p.exited;
      itermHelperOk = false;
      console.error(`iterm2 helper exited — ${Math.round(retryMs / 1000)}s 後に再接続`);
      setTimeout(() => startItermHelper(Math.min(retryMs * 2, 60_000)), retryMs);
    })();
  } catch {}
}
startItermHelper();

const ITERM_CAPTURE_SCRIPT = `
tell application "iTerm2"
  set out to ""
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        set out to out & "\\u0001TTY:" & (tty of s) & "\\u0002" & (text of s)
      end repeat
    end repeat
  end repeat
  return out
end tell`;

async function captureScreens(ttys: string[]): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const panes = await tmuxPanes();
  const paneByTty = new Map(panes.map(p => [p.tty, p]));
  const need = new Set(ttys.filter(Boolean));
  // tmux ペインは capture-pane で
  const tmuxTargets = [...need].filter(t => paneByTty.has(t));
  await Promise.all(tmuxTargets.map(async t => {
    const p = paneByTty.get(t)!;
    const text = await sh(["tmux", "capture-pane", "-p", "-e", "-t", p.paneId, "-S", "-5"]);
    if (text) result.set(t, text.trimEnd());
  }));
  // Python API ヘルパーの新鮮なデータがあれば優先(色付き)
  for (const t of need) {
    if (result.has(t)) continue;
    const cached = itermScreens.get(t);
    if (cached && Date.now() - cached.at < 7000) result.set(t, cached.text);
  }
  // 残りは AppleScript で一括取得(モノクロ・フォールバック)
  if ([...need].some(t => !result.has(t))) {
    const raw = await osascript(ITERM_CAPTURE_SCRIPT.replace(/\\u0001/g, "\x01").replace(/\\u0002/g, "\x02"));
    for (const chunk of raw.split("\x01")) {
      if (!chunk.startsWith("TTY:")) continue;
      const sep = chunk.indexOf("\x02");
      const tty = chunk.slice(4, sep).replace("/dev/", "").trim();
      if (need.has(tty) && !result.has(tty)) result.set(tty, chunk.slice(sep + 1).trimEnd());
    }
  }
  return result;
}

// ---------------------------------------------------------------- 選択プロンプト検出
// Claude の許可プロンプト/AskUserQuestion は「❯ 1. Yes」形式の番号付き選択肢、
// codex 等は「❯ Yes」形式のカーソル選択。画面末尾から検出する。
function detectPrompt(screen: string | undefined): PromptInfo | null {
  if (!screen) return null;
  // 画面テキストは ANSI カラー付きで来るためパターン照合前に除去する
  const plain = screen
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "")
    .replace(/\x00/g, " ");
  const lines = plain.split("\n").slice(-18).map(l => l.replace(/[│┃]/g, " ").trimEnd());
  const optRe = /^\s*(❯)?\s*(\d+)\.\s+(.+)$/;
  const opts: { key: string; label: string }[] = [];
  let hasCursor = false, firstIdx = -1;
  lines.forEach((l, i) => {
    const m = l.match(optRe);
    if (m) {
      if (opts.length === 0) firstIdx = i;
      if (m[1]) hasCursor = true;
      opts.push({ key: m[2], label: m[3].trim().slice(0, 70) });
    }
  });
  const findQuestion = (above: number): string | undefined => {
    for (let i = above - 1; i >= 0 && i > above - 7; i--) {
      const t = lines[i].trim();
      if (/[??]$/.test(t)) return t.slice(0, 120);
    }
    return undefined;
  };
  if (opts.length >= 2 && hasCursor)
    return { question: findQuestion(firstIdx), options: opts.slice(0, 8), kind: "numbered" };
  // 非番号のカーソル選択(❯ Yes 形式)。空の入力プロンプト(❯ のみ)は除外
  const cursorIdx = lines.findIndex(l => /^\s*❯\s+\S/.test(l) && !optRe.test(l));
  if (cursorIdx >= 0) {
    // カーソル行の上下に連続する「選択肢らしい行」をブロックとして解析
    const isOpt = (l: string) => {
      const t = l.replace(/^\s*❯?\s*/, "").trim();
      return t.length > 0 && t.length <= 80 &&
        !/[??]$/.test(t) &&                       // 質問文
        !/[┌┐└┘─╭╮╰╯═━]/.test(t) &&               // 罫線
        !/ · |^Esc |^Press |^ctrl|^Tab /i.test(t); // 操作ヒント行
    };
    let start = cursorIdx, end = cursorIdx;
    while (start > 0 && isOpt(lines[start - 1])) start--;
    while (end < lines.length - 1 && isOpt(lines[end + 1])) end++;
    const copts: { key: string; label: string }[] = [];
    for (let i = start; i <= end; i++)
      copts.push({ key: `opt:${i - start}`, label: lines[i].replace(/^\s*❯?\s*/, "").trim().slice(0, 70) });
    if (copts.length >= 2 && copts.length <= 8)
      return { question: findQuestion(start), options: copts, kind: "cursor", cursorIndex: cursorIdx - start };
    return { options: [] };
  }
  return null;
}

// ---------------------------------------------------------------- git 情報(15秒キャッシュ)
const gitCache = new Map<string, { info: GitInfo | null; at: number }>();
async function gitInfo(cwd: string): Promise<GitInfo | null> {
  const c = gitCache.get(cwd);
  if (c && Date.now() - c.at < 15_000) return c.info;
  const out = await sh(["git", "-C", cwd, "status", "--porcelain", "--branch"]);
  let info: GitInfo | null = null;
  if (out) {
    const lines = out.trimEnd().split("\n");
    const head = lines[0] ?? "";
    const bm = head.match(/^## ([^.\s]+(?:[^\s]*)?)/);
    let branch = bm ? bm[1].split("...")[0] : "";
    if (head.includes("HEAD (no branch)")) branch = "(detached)";
    const ahead = Number(head.match(/ahead (\d+)/)?.[1] ?? 0);
    const behind = Number(head.match(/behind (\d+)/)?.[1] ?? 0);
    info = { branch, dirty: lines.length - 1, ahead, behind };
  }
  gitCache.set(cwd, { info, at: Date.now() });
  return info;
}

// ---------------------------------------------------------------- 設定 + macOS 通知
const CONFIG_PATH = join(HOME, ".cache", "agd", "config.json");
let config: { macNotify: boolean } = { macNotify: false };
try { config = { ...config, ...JSON.parse(readFileSync(CONFIG_PATH, "utf8")) }; } catch {}
async function saveConfig() { try { await Bun.write(CONFIG_PATH, JSON.stringify(config)); } catch {} }

let notifierPath: string | null | undefined; // undefined=未チェック
async function macNotify(title: string, body: string, tty: string) {
  if (notifierPath === undefined)
    notifierPath = (await sh(["sh", "-c", "command -v terminal-notifier"])).trim() || null;
  if (notifierPath) {
    const args = [notifierPath, "-title", title, "-message", body, "-group", `agd-${tty || title}`];
    if (tty) args.push("-execute", `curl -s -X POST http://localhost:${PORT}/api/focus -H 'Content-Type: application/json' -d '{"tty":"${tty}"}'`);
    await sh(args);
  } else {
    await osascript(`display notification "${body.replace(/"/g, "'")}" with title "${title.replace(/"/g, "'")}"`);
  }
}

// ---------------------------------------------------------------- 入力送信 / フォーカス / resume
const ITERM_WRITE_SCRIPT = `
on run argv
  set target to item 1 of argv
  set msg to item 2 of argv
  tell application "iTerm2"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if tty of s is target then
            tell s to write text msg
            return "ok"
          end if
        end repeat
      end repeat
    end repeat
  end tell
  return "not found"
end run`;

async function sendToTty(tty: string, text: string): Promise<string> {
  // テキストと Enter は必ず分離して間隔を空けて送る。
  // 一体で送ると TUI のペースト判定次第で末尾改行が「送信」にならないことがある。
  // 複数行はブラケットペーストで包む(素のまま送ると改行ごとに送信されてしまう)。
  const payload = text.includes("\n") ? `\x1b[200~${text}\x1b[201~` : text;
  const panes = await tmuxPanes();
  const pane = panes.find(p => p.tty === tty);
  if (pane) {
    await sh(["tmux", "send-keys", "-t", pane.paneId, "-l", payload]);
    await Bun.sleep(150);
    await sh(["tmux", "send-keys", "-t", pane.paneId, "Enter"]);
    return "ok(tmux)";
  }
  const r = await shStrict(["osascript", "-", `/dev/${tty}`, "text", payload], ITERM_KEY_SCRIPT);
  if (!r.startsWith("ok")) return r;
  await Bun.sleep(150);
  return shStrict(["osascript", "-", `/dev/${tty}`, "enter", ""], ITERM_KEY_SCRIPT);
}

// 生キー送信(数字選択・y/n・Enter・Esc)。Enter を付けない
const ITERM_KEY_SCRIPT = `
on run argv
  set theTarget to item 1 of argv
  set theKind to item 2 of argv
  set thePayload to item 3 of argv
  tell application "iTerm2"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if tty of s is theTarget then
            if theKind is "enter" then
              tell s to write text ""
            else if theKind is "escape" then
              tell s to write text (character id 27) newline NO
            else if theKind is "csi" then
              tell s to write text ((character id 27) & "[" & thePayload) newline NO
            else if theKind is "tab" then
              tell s to write text (character id 9) newline NO
            else
              tell s to write text thePayload newline NO
            end if
            return "ok"
          end if
        end repeat
      end repeat
    end repeat
  end tell
  return "not found"
end run`;

const NAMED_KEYS = new Set(["Enter", "Escape", "Up", "Down", "Left", "Right", "Tab", "ShiftTab"]);
const CSI_MAP: Record<string, string> = { Up: "A", Down: "B", Right: "C", Left: "D", ShiftTab: "Z" };

async function sendKeyToTty(tty: string, key: string): Promise<string> {
  const panes = await tmuxPanes();
  const pane = panes.find(p => p.tty === tty);
  if (pane) {
    if (key === "ShiftTab") await sh(["tmux", "send-keys", "-t", pane.paneId, "BTab"]);
    else if (NAMED_KEYS.has(key)) await sh(["tmux", "send-keys", "-t", pane.paneId, key]);
    else await sh(["tmux", "send-keys", "-t", pane.paneId, "-l", key]);
    return "ok(tmux)";
  }
  let kind = "text", payload = key;
  if (key === "Enter") kind = "enter";
  else if (key === "Escape") kind = "escape";
  else if (key === "Tab") kind = "tab";
  else if (CSI_MAP[key]) { kind = "csi"; payload = CSI_MAP[key]; }
  const r = await shStrict(["osascript", "-", `/dev/${tty}`, kind, payload], ITERM_KEY_SCRIPT);
  return r;
}

// stderr も見て AppleScript エラーを表面化させる版
async function shStrict(cmd: string[], input?: string): Promise<string> {
  try {
    const p = Bun.spawn(cmd, { stdin: input ? new TextEncoder().encode(input) : undefined, stderr: "pipe" });
    const [out, err] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
    ]);
    await p.exited;
    if (out.trim()) return out.trim();
    if (err.trim()) return "error: " + err.trim().split("\n")[0].slice(0, 200);
    return "ok";
  } catch (e: any) {
    return "error: " + (e?.message ?? String(e));
  }
}

// キー列を順に送る(カーソル選択: Down×n → Enter など)
async function sendKeysToTty(tty: string, keys: string[]): Promise<string> {
  let last = "ok";
  for (const k of keys.slice(0, 20)) {
    last = await sendKeyToTty(tty, k);
    await Bun.sleep(120);
  }
  return last;
}

// セッション終了(タブ/ペインを閉じる)
const ITERM_CLOSE_SCRIPT = `
on run argv
  set theTarget to item 1 of argv
  tell application "iTerm2"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if tty of s is theTarget then
            close s
            return "ok"
          end if
        end repeat
      end repeat
    end repeat
  end tell
  return "not found"
end run`;

async function closeTty(tty: string): Promise<string> {
  const panes = await tmuxPanes();
  const pane = panes.find(p => p.tty === tty);
  if (pane) {
    await sh(["tmux", "kill-pane", "-t", pane.paneId]);
    return "ok(tmux)";
  }
  return shStrict(["osascript", "-", `/dev/${tty}`], ITERM_CLOSE_SCRIPT);
}

const ITERM_FOCUS_SCRIPT = `
on run argv
  set target to item 1 of argv
  tell application "iTerm2"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if tty of s is target then
            tell t to select
            tell s to select
            set index of w to 1
            activate
            return "ok"
          end if
        end repeat
      end repeat
    end repeat
  end tell
  return "not found"
end run`;

async function focusTty(tty: string): Promise<string> {
  const r = await sh(["osascript", "-", `/dev/${tty}`], ITERM_FOCUS_SCRIPT);
  return r.trim();
}

// 注意: activate は入れない(起動のたびにブラウザからフォーカスを奪わないため)。
// ターミナルへ移動したいときは ⌖/f のジャンプ(focus API)を使う
const ITERM_NEWTAB_SCRIPT = `
on run argv
  set cmd to item 1 of argv
  tell application "iTerm2"
    if (count of windows) is 0 then
      create window with default profile
    else
      tell current window to create tab with default profile
    end if
    tell current session of current window to write text cmd
  end tell
end run`;

async function openResume(agent: string, sid: string, cwd: string): Promise<string> {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const cmd = agent === "claude"
    ? `cd ${q(cwd)} && claude --resume ${sid}`
    : `cd ${q(cwd)} && codex resume ${sid}`;
  await sh(["osascript", "-", cmd], ITERM_NEWTAB_SCRIPT);
  return "ok";
}

// ---------------------------------------------------------------- トランスクリプト解析
type LogEntry = { role: string; title?: string; text: string; ts?: string };

function parseClaudeLines(lines: string[]): LogEntry[] {
  const entries: LogEntry[] = [];
  for (const l of lines) {
    let o: any; try { o = JSON.parse(l); } catch { continue; }
    const ts = o.timestamp;
    if (o.type === "user") {
      const c = o.message?.content;
      if (typeof c === "string") { if (c.trim()) entries.push({ role: "user", text: c, ts }); }
      else if (Array.isArray(c)) for (const item of c) {
        if (item.type === "text" && item.text?.trim() && !item.text.startsWith("<local-command") && !item.text.startsWith("<command-name>"))
          entries.push({ role: "user", text: item.text, ts });
        else if (item.type === "tool_result") {
          const t = typeof item.content === "string" ? item.content
            : Array.isArray(item.content) ? item.content.map((x: any) => x.text ?? "").join("\n") : "";
          if (t.trim()) entries.push({ role: "tool_result", title: "結果", text: t, ts });
        }
      }
    } else if (o.type === "assistant") {
      const c = o.message?.content;
      if (Array.isArray(c)) for (const item of c) {
        if (item.type === "text" && item.text?.trim()) entries.push({ role: "assistant", text: item.text, ts });
        else if (item.type === "thinking" && item.thinking?.trim()) entries.push({ role: "thinking", title: "思考", text: item.thinking, ts });
        else if (item.type === "tool_use") entries.push({ role: "tool_use", title: item.name, text: JSON.stringify(item.input ?? {}, null, 1), ts });
      }
    }
  }
  return entries;
}

function parseCodexLines(lines: string[]): LogEntry[] {
  const entries: LogEntry[] = [];
  const textOf = (content: any): string => {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) return content.map((x: any) => x.text ?? x.summary_text ?? "").filter(Boolean).join("\n");
    return "";
  };
  for (const l of lines) {
    let o: any; try { o = JSON.parse(l); } catch { continue; }
    if (o.type !== "response_item") continue;
    const p = o.payload; if (!p) continue;
    const ts = o.timestamp;
    if (p.type === "message") {
      if (p.role === "user") {
        const t = textOf(p.content);
        // 環境コンテキストなどのシステム的メッセージを除外
        if (t.trim() && !t.startsWith("<environment_context>") && !t.startsWith("<turn_aborted")) entries.push({ role: "user", text: t, ts });
      } else if (p.role === "assistant") {
        const t = textOf(p.content);
        if (t.trim()) entries.push({ role: "assistant", text: t, ts });
      }
    } else if (p.type === "reasoning") {
      const t = textOf(p.summary) || textOf(p.content);
      if (t.trim()) entries.push({ role: "thinking", title: "思考", text: t, ts });
    } else if (p.type === "function_call") {
      entries.push({ role: "tool_use", title: p.name ?? "tool", text: String(p.arguments ?? ""), ts });
    } else if (p.type === "function_call_output") {
      const t = typeof p.output === "string" ? p.output : textOf(p.output?.content ?? p.output);
      if (t.trim()) entries.push({ role: "tool_result", title: "結果", text: t, ts });
    }
  }
  return entries;
}

// ---- 増分読み込みキャッシュ: ファイルの新規追記分だけを読んでパースする ----
type TranscriptCache = { offset: number; entries: LogEntry[] };
const transcriptCache = new Map<string, TranscriptCache>();
const TRANSCRIPT_CACHE_MAX = 8;

function readTranscript(path: string, agent: "claude" | "codex"): LogEntry[] {
  let st;
  try { st = statSync(path); } catch { return []; }
  let c = transcriptCache.get(path);
  if (!c || st.size < c.offset) c = { offset: 0, entries: [] };  // 縮んだら作り直し
  if (st.size > c.offset) {
    try {
      const fd = openSync(path, "r");
      const len = st.size - c.offset;
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, c.offset);
      closeSync(fd);
      const chunk = buf.toString("utf8");
      const lastNl = chunk.lastIndexOf("\n");
      if (lastNl >= 0) {
        // 完結した行だけパースし、書きかけの末尾行は次回に回す(オフセットは常に行境界)
        const complete = chunk.slice(0, lastNl);
        c.offset += Buffer.byteLength(complete, "utf8") + 1;
        const lines = complete.split("\n").filter(Boolean);
        c.entries.push(...(agent === "claude" ? parseClaudeLines(lines) : parseCodexLines(lines)));
      }
    } catch {}
  }
  transcriptCache.delete(path);           // LRU: 触ったものを末尾へ
  transcriptCache.set(path, c);
  while (transcriptCache.size > TRANSCRIPT_CACHE_MAX)
    transcriptCache.delete(transcriptCache.keys().next().value!);
  return c.entries;
}

const TRUNCATE_AT = 4000;
function truncateEntry(e: LogEntry): LogEntry & { truncated?: boolean } {
  if (e.text.length <= TRUNCATE_AT) return e;
  return { ...e, text: e.text.slice(0, TRUNCATE_AT), truncated: true };
}

// サブエージェントのトランスクリプト: <projects>/<dir>/<sid>/subagents/agent-*.jsonl
function claudeSubagentsDir(sid: string): string | null {
  const t = findClaudeTranscript(sid);
  return t ? t.replace(/\.jsonl$/, "") + "/subagents" : null;
}

function listSubagents(sid: string): { id: string; name: string; mtime: number; active: boolean }[] {
  const dir = claudeSubagentsDir(sid);
  if (!dir) return [];
  const out: { id: string; name: string; mtime: number; active: boolean }[] = [];
  let files: string[] = [];
  try { files = readdirSync(dir).filter(f => /^agent-[A-Za-z0-9_-]+\.jsonl$/.test(f)); } catch { return []; }
  for (const f of files) {
    const p = join(dir, f);
    let st; try { st = statSync(p); } catch { continue; }
    const id = f.replace(/^agent-/, "").replace(/\.jsonl$/, "");
    // 先頭行(サブエージェントへの指示)から表示名を作る
    let name = id;
    try {
      const fd = openSync(p, "r");
      const buf = Buffer.alloc(65536);
      const n = readSync(fd, buf, 0, 65536, 0);
      closeSync(fd);
      const line = buf.toString("utf8", 0, n).split("\n")[0];
      const o = JSON.parse(line);
      const c = o?.message?.content;
      const text = typeof c === "string" ? c : Array.isArray(c) ? (c.find((x: any) => x.type === "text")?.text ?? "") : "";
      if (text.trim()) name = text.trim().replace(/\s+/g, " ").slice(0, 60);
    } catch {}
    out.push({ id, name, mtime: st.mtimeMs, active: Date.now() - st.mtimeMs < 30_000 });
  }
  return out.sort((a, b) => a.mtime - b.mtime);
}

function findClaudeTranscript(sid: string): string | null {
  let dirs: string[] = [];
  try { dirs = readdirSync(CLAUDE_PROJECTS); } catch { return null; }
  for (const d of dirs) {
    const p = join(CLAUDE_PROJECTS, d, `${sid}.jsonl`);
    if (existsSync(p)) return p;
  }
  return null;
}

// ---------------------------------------------------------------- 横断ログ検索
type SearchHit = { agent: string; sid: string; name: string; cwd: string; mtime: number; count: number; snippet: string };

function claudeNameFor(sid: string, path: string): string {
  try {
    const head = readFileSync(path, "utf8").slice(0, 200_000);
    const s = head.match(/"type":"summary".*?"summary":"([^"]+)"/);
    if (s) return s[1].slice(0, 60);
  } catch {}
  return historyPrompt(sid) || sid;
}

async function searchLogs(q: string): Promise<SearchHit[]> {
  // 対象ファイル収集(claude 全プロジェクト + codex rollout、新しい順に最大400)
  const files: { path: string; agent: "claude" | "codex"; sid: string; cwd: string; mtime: number }[] = [];
  try {
    for (const d of readdirSync(CLAUDE_PROJECTS)) {
      const dir = join(CLAUDE_PROJECTS, d);
      let fs2: string[] = [];
      try { fs2 = readdirSync(dir).filter(f => f.endsWith(".jsonl")); } catch { continue; }
      for (const f of fs2) {
        try {
          const st = statSync(join(dir, f));
          files.push({ path: join(dir, f), agent: "claude", sid: f.replace(/\.jsonl$/, ""), cwd: "", mtime: st.mtimeMs });
        } catch {}
      }
    }
  } catch {}
  for (const m of rolloutCache.values())
    if (m.id) files.push({ path: m.path, agent: "codex", sid: m.id, cwd: m.cwd, mtime: m.mtime * 1000 });
  files.sort((a, b) => b.mtime - a.mtime);
  const targets = files.slice(0, 250);
  // grep -liF でヒットファイルを絞る(50件ずつ並列)
  const matched = new Set<string>();
  const chunks: typeof targets[] = [];
  for (let i = 0; i < targets.length; i += 50) chunks.push(targets.slice(i, i + 50));
  await Promise.all(chunks.map(async chunk => {
    const out = await sh(["grep", "-liF", q, ...chunk.map(f => f.path)]);
    for (const l of out.trim().split("\n")) if (l) matched.add(l);
  }));
  // 上位30件は grep で件数とスニペットだけ取る(全文パースは重い)
  const top = targets.filter(f => matched.has(f.path)).slice(0, 30);
  const hits: SearchHit[] = [];
  await Promise.all(top.map(async f => {
    const [cntOut, lineOut] = await Promise.all([
      sh(["grep", "-cF", "-m", "99", q, f.path]),
      sh(["grep", "-m1", "-F", q, f.path]),
    ]);
    const count = Number(cntOut.trim()) || 1;
    const idx = lineOut.indexOf(q);
    let snippet = idx >= 0 ? lineOut.slice(Math.max(0, idx - 80), idx + q.length + 120) : "";
    snippet = snippet.replace(/\\n/g, " ").replace(/\\"/g, '"').replace(/\\t/g, " ");
    let cwd = f.cwd, name = "";
    if (f.agent === "claude") {
      try {
        const head = readFileSync(f.path, "utf8").slice(0, 200_000);
        cwd = head.match(/"cwd":"([^"]+)"/)?.[1] ?? "";
      } catch {}
      name = claudeNameFor(f.sid, f.path);
    } else {
      name = codexNames.get(f.sid) || f.sid;
    }
    hits.push({ agent: f.agent, sid: f.sid, name, cwd, mtime: f.mtime, count, snippet });
  }));
  hits.sort((a, b) => b.mtime - a.mtime);
  return hits;
}

// ---------------------------------------------------------------- 新規セッション起動
async function openNew(agent: string, cwd: string): Promise<string> {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const cmd = `cd ${q(cwd)} && ${agent === "codex" ? "codex" : "claude"}`;
  await sh(["osascript", "-", cmd], ITERM_NEWTAB_SCRIPT);
  return "ok";
}

// ---------------------------------------------------------------- スラッシュコマンド一覧
const CLAUDE_SLASH: [string, string][] = [
  ["/clear", "コンテキストをクリア"], ["/compact", "会話を要約して圧縮"], ["/cost", "コスト・使用量を表示"],
  ["/status", "ステータス表示"], ["/model", "モデル切替"], ["/permissions", "権限設定"],
  ["/config", "設定を開く"], ["/agents", "エージェント管理"], ["/mcp", "MCPサーバー管理"],
  ["/memory", "メモリ(CLAUDE.md)編集"], ["/init", "CLAUDE.md を生成"], ["/resume", "セッション再開ピッカー"],
  ["/rewind", "巻き戻し"], ["/review", "コードレビュー"], ["/export", "会話をエクスポート"],
  ["/todos", "タスク一覧"], ["/hooks", "フック設定"], ["/statusline", "ステータスライン設定"],
  ["/add-dir", "作業ディレクトリ追加"], ["/vim", "vimモード切替"], ["/doctor", "診断"],
  ["/help", "ヘルプ"], ["/exit", "終了"],
];
const CODEX_SLASH: [string, string][] = [
  ["/new", "新しい会話を開始"], ["/init", "AGENTS.md を生成"], ["/compact", "会話を圧縮"],
  ["/diff", "変更差分を表示"], ["/review", "コードレビュー"], ["/model", "モデル切替"],
  ["/approvals", "承認モード切替"], ["/mention", "ファイルをメンション"], ["/status", "ステータス表示"],
  ["/mcp", "MCPサーバー表示"], ["/undo", "直前の変更を取り消し"], ["/logout", "ログアウト"], ["/quit", "終了"],
];

function customCommands(agent: string, cwd: string): [string, string][] {
  const out: [string, string][] = [];
  const dirs = agent === "codex"
    ? [join(HOME, ".codex", "prompts")]
    : [join(HOME, ".claude", "commands"), cwd ? join(cwd, ".claude", "commands") : ""];
  for (const d of dirs) {
    if (!d) continue;
    try {
      for (const f of readdirSync(d)) {
        if (!f.endsWith(".md")) continue;
        out.push([`/${f.replace(/\.md$/, "")}`, "カスタムコマンド"]);
      }
    } catch {}
  }
  return out;
}

// ---------------------------------------------------------------- ポーリング + WebSocket
type Snapshot = { sessions: (Session & { screen?: string })[]; at: number };
let lastSnapshot: Snapshot = { sessions: [], at: 0 };
const prevStatus = new Map<string, string>();
const wsClients = new Set<any>();

async function poll() {
  try {
    await updateRolloutCache();
    loadCodexNames();
    const [cr, xr] = await Promise.all([claudeRunning(), codexRunning()]);
    const running = [...cr, ...xr];
    const runningSids = new Set(running.map(s => s.sid));
    const recents = [...claudeRecent(runningSids), ...codexRecent(runningSids)]
      .filter(s => !runningSids.has(s.sid));
    const screens = await captureScreens(running.map(s => s.tty));
    // 画面から選択プロンプトを検出。codex はこれで waiting 判定も行う
    for (const s of running) {
      const p = detectPrompt(screens.get(s.tty));
      if (p) {
        s.prompt = p;
        // 誤検出防止: waiting への昇格は「番号付き選択肢」または「codexのカーソル選択」のみ
        const confident = p.kind === "numbered" || (s.agent === "codex" && p.kind === "cursor");
        if (confident && s.status === "idle") s.status = "waiting";
      }
    }
    // git 情報(キャッシュ付き)
    await Promise.all(running.map(async s => {
      const g = await gitInfo(s.cwd);
      if (g) s.git = g;
    }));
    const order: Record<string, number> = { waiting: 0, busy: 1, idle: 2, resumable: 3 };
    const sessions = [...running, ...recents]
      .sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9) || a.ageS - b.ageS)
      .map(s => ({ ...s, screen: screens.get(s.tty) }));
    lastSnapshot = { sessions, at: Date.now() };
    // 状態変化検知 → 通知イベント
    const changes: { key: string; name: string; agent: string; from: string; to: string; tty: string }[] = [];
    for (const s of running) {
      const prev = prevStatus.get(s.key);
      if (prev && prev !== s.status) changes.push({ key: s.key, name: s.name, agent: s.agent, from: prev, to: s.status, tty: s.tty });
      prevStatus.set(s.key, s.status);
    }
    // macOS 通知(busy→waiting/idle)
    if (config.macNotify) {
      for (const c of changes) {
        if (c.from === "busy" && (c.to === "waiting" || c.to === "idle")) {
          const label = c.to === "waiting" ? "入力待ち" : "完了";
          macNotify(`${c.name} — ${label}`, `${c.agent} / クリックでターミナルへ`, c.tty).catch(() => {});
        }
      }
    }
    const msg = JSON.stringify({ type: "snapshot", ...lastSnapshot, changes });
    for (const ws of wsClients) { try { ws.send(msg); } catch {} }
  } catch (e) {
    console.error("poll error:", e);
  } finally {
    setTimeout(poll, POLL_MS);
  }
}

// ---------------------------------------------------------------- HTTP サーバー
const INDEX_HTML = join(import.meta.dir, "public", "index.html");

try {
  Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",  // セッションへのコマンド送信が可能なため、必ず localhost のみにバインドする
  idleTimeout: 60,
  async fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      if (server.upgrade(req)) return undefined as any;
      return new Response("upgrade failed", { status: 400 });
    }
    const noCache = { "Cache-Control": "no-store" };
    if (url.pathname === "/" || url.pathname === "/index.html")
      return new Response(Bun.file(INDEX_HTML), { headers: noCache });
    if (url.pathname === "/app.js")
      return new Response(Bun.file(join(import.meta.dir, "public", "app.js")), { headers: noCache });
    if (url.pathname === "/api/sessions")
      return Response.json(lastSnapshot);
    if (url.pathname === "/api/projects") {
      const cwds = [...new Set(lastSnapshot.sessions.map(s => s.cwd).filter(Boolean))].sort();
      return Response.json({ projects: cwds });
    }
    if (url.pathname === "/api/search") {
      const q = url.searchParams.get("q") ?? "";
      if (q.length < 2) return Response.json({ hits: [] });
      return Response.json({ hits: await searchLogs(q) });
    }
    if (url.pathname === "/api/slash") {
      const agent = url.searchParams.get("agent") ?? "claude";
      const cwd = url.searchParams.get("cwd") ?? "";
      const builtins = agent === "codex" ? CODEX_SLASH : CLAUDE_SLASH;
      const seen = new Set(builtins.map(([c]) => c));
      const custom = customCommands(agent, cwd).filter(([c]) => !seen.has(c));
      return Response.json({ commands: [...builtins, ...custom].map(([cmd, desc]) => ({ cmd, desc })) });
    }
    if (url.pathname === "/api/config") {
      if (req.method === "POST") {
        const body = await req.json();
        if (typeof body.macNotify === "boolean") config.macNotify = body.macNotify;
        await saveConfig();
      }
      // AGD_PATH_STRIP: 表示上「…」に短縮する共通パスプレフィックス(例: ~/projects)
      const pathStrip = (process.env.AGD_PATH_STRIP ?? "").replace(/^~(?=\/|$)/, HOME);
      return Response.json({ ...config, pathStrip });
    }
    if (req.method === "POST" && url.pathname === "/api/key") {
      const { tty, key, keys } = await req.json();
      if (!tty || (!key && !Array.isArray(keys))) return Response.json({ error: "tty and key(s) required" }, { status: 400 });
      const r = Array.isArray(keys)
        ? await sendKeysToTty(tty, keys.map((k: any) => String(k).slice(0, 10)))
        : await sendKeyToTty(tty, String(key).slice(0, 10));
      return Response.json({ result: r });
    }
    if (req.method === "POST" && url.pathname === "/api/new") {
      const { agent, cwd } = await req.json();
      const abs = String(cwd ?? "").replace(/^~(?=\/|$)/, HOME);
      if (!abs || !existsSync(abs)) return Response.json({ error: "invalid cwd" }, { status: 400 });
      const r = await openNew(agent === "codex" ? "codex" : "claude", abs);
      return Response.json({ result: r });
    }
    if (url.pathname === "/api/transcript") {
      const agent = url.searchParams.get("agent") ?? "";
      const sid = url.searchParams.get("sid") ?? "";
      const limit = Number(url.searchParams.get("limit") ?? 300);
      const sub = url.searchParams.get("sub");
      let path = agent === "claude" ? findClaudeTranscript(sid) : rolloutById(sid)?.path;
      if (sub && agent === "claude" && /^[A-Za-z0-9_-]+$/.test(sub)) {
        const dir = claudeSubagentsDir(sid);
        path = dir ? join(dir, `agent-${sub}.jsonl`) : null;
      }
      if (!path || !existsSync(path)) return Response.json({ entries: [], start: 0, total: 0 });
      const all = readTranscript(path, agent === "claude" ? "claude" : "codex");
      // ?entry=N → 該当エントリの全文(切り詰めなし)
      const entryIdx = url.searchParams.get("entry");
      if (entryIdx !== null) return Response.json({ entry: all[Number(entryIdx)] ?? null });
      // ?before=N → それより古い limit 件 / ?from=N → N以降すべて / 指定なし → 末尾 limit 件
      const before = url.searchParams.get("before");
      const from = url.searchParams.get("from");
      let start: number;
      let end: number;
      if (before !== null) { end = Math.min(Number(before), all.length); start = Math.max(0, end - limit); }
      else if (from !== null) { start = Math.max(0, Number(from)); end = all.length; }
      else { end = all.length; start = Math.max(0, end - limit); }
      return Response.json({ entries: all.slice(start, end).map(truncateEntry), start, total: all.length });
    }
    if (url.pathname === "/api/subagents") {
      const agent = url.searchParams.get("agent") ?? "";
      const sid = url.searchParams.get("sid") ?? "";
      if (agent !== "claude") return Response.json({ subagents: [] });
      return Response.json({ subagents: listSubagents(sid) });
    }
    if (url.pathname === "/api/dirs") {
      // パス入力補完: q の親ディレクトリを列挙して前方一致のディレクトリを返す
      const q = (url.searchParams.get("q") ?? "").replace(/^~(?=\/|$)/, HOME);
      if (!q.startsWith("/")) return Response.json({ dirs: [] });
      const cut = q.lastIndexOf("/");
      const base = cut === 0 ? "/" : q.slice(0, cut);
      const prefix = q.slice(cut + 1).toLowerCase();
      const dirs: string[] = [];
      try {
        for (const name of readdirSync(base)) {
          if (dirs.length >= 15) break;
          if (name.startsWith(".") && !prefix.startsWith(".")) continue;
          if (!name.toLowerCase().startsWith(prefix)) continue;
          const full = join(base, name);
          try { if (statSync(full).isDirectory()) dirs.push(full); } catch {}
        }
      } catch {}
      return Response.json({ dirs });
    }
    if (req.method === "POST" && url.pathname === "/api/send") {
      const { tty, text } = await req.json();
      if (!tty || !text) return Response.json({ error: "tty and text required" }, { status: 400 });
      const r = await sendToTty(tty, text);
      return Response.json({ result: r });
    }
    if (req.method === "POST" && url.pathname === "/api/close") {
      const { tty } = await req.json();
      if (!tty) return Response.json({ error: "tty required" }, { status: 400 });
      const r = await closeTty(tty);
      return Response.json({ result: r });
    }
    if (req.method === "POST" && url.pathname === "/api/focus") {
      const { tty } = await req.json();
      const r = await focusTty(tty);
      return Response.json({ result: r });
    }
    if (req.method === "POST" && url.pathname === "/api/resume") {
      const { agent, sid, cwd } = await req.json();
      const r = await openResume(agent, sid, cwd);
      return Response.json({ result: r });
    }
    return new Response("not found", { status: 404 });
  },
  websocket: {
    open(ws) {
      wsClients.add(ws);
      ws.send(JSON.stringify({ type: "snapshot", ...lastSnapshot, changes: [] }));
    },
    close(ws) { wsClients.delete(ws); },
    message() {},
  },
  });
} catch (e: any) {
  if (e?.code === "EADDRINUSE") {
    console.log(`agd web は既に起動しています → http://localhost:${PORT}`);
    console.log(`別ポートで起動する場合: AGD_PORT=8788 agd web / 停止する場合: pkill -f 'bun run.*server.ts'`);
    process.exit(0);
  }
  throw e;
}

console.log(`agd web: http://localhost:${PORT}`);
poll();
