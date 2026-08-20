// agd web — AI Agent Session Dashboard server (Bun)
// 実行中の Claude Code / Codex セッションの一覧・ライブ画面・ログ閲覧・入力送信・通知を
// ブラウザに提供する。起動: bun run server.ts (デフォルト http://localhost:8787)
import { readdirSync, statSync, existsSync, readFileSync, openSync, readSync, closeSync, mkdirSync } from "fs";
import { join } from "path";
import { readTranscript, truncateEntry, type LogEntry } from "./transcript";
import {
  detectPrompt, detectAskPrompt, parseTmuxPanes, TMUX_PANE_FORMAT,
  type PromptInfo, type TmuxPane,
} from "./screen";
import {
  remoteSessions, remoteCapture, remoteSend, remoteKey, remoteClose, remotePing, remoteNew, remoteResume,
  syncRemoteTranscript, remoteSelectPane,
  type RemoteHost,
} from "./remote";
import { homedir } from "os";

const PORT = Number(process.env.AGD_PORT || 8787);
const HOME = homedir();
const CODEX_SESSIONS = join(HOME, ".codex", "sessions");
const CODEX_INDEX = join(HOME, ".codex", "session_index.jsonl");
const CLAUDE_PROJECTS = join(HOME, ".claude", "projects");
const CLAUDE_HISTORY = join(HOME, ".claude", "history.jsonl");
const POLL_MS = 2500;
// 端末画面をどこまで遡って取り込むか(行)。AGD_SCROLLBACK で変えられる
const SCROLLBACK = Number(process.env.AGD_SCROLLBACK || 200);
const BUSY_WINDOW_S = 20;
const RECENT_LIMIT = 10;
const OSASCRIPT_TIMEOUT_MS = 3000;

// ---------------------------------------------------------------- 共通ユーティリティ
async function runCommand(cmd: string[], input?: string, timeoutMs?: number) {
  const p = Bun.spawn(cmd, {
    stdin: input ? new TextEncoder().encode(input) : undefined,
    stderr: "pipe",
  });
  const outPromise = new Response(p.stdout).text();
  const errPromise = new Response(p.stderr).text();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = timeoutMs === undefined ? false : await Promise.race([
    p.exited.then(() => false),
    new Promise<true>(resolve => { timer = setTimeout(() => resolve(true), timeoutMs); }),
  ]);
  if (timer) clearTimeout(timer);
  if (timedOut) {
    // Apple Events が詰まっても子プロセスを残さない。通常終了を少し待ち、だめなら強制終了する
    try { p.kill("SIGTERM"); } catch {}
    const exited = await Promise.race([
      p.exited.then(() => true),
      Bun.sleep(250).then(() => false),
    ]);
    if (!exited) {
      try { p.kill("SIGKILL"); } catch {}
    }
  }
  await p.exited;
  const [out, err] = await Promise.all([outPromise, errPromise]);
  return { out, err, timedOut };
}

async function sh(cmd: string[], input?: string, timeoutMs?: number): Promise<string> {
  try {
    const r = await runCommand(cmd, input, timeoutMs);
    return r.timedOut ? "" : r.out;
  } catch {
    return "";
  }
}

async function osascriptResult(script: string, args: string[] = [], timeoutMs = OSASCRIPT_TIMEOUT_MS) {
  try {
    const r = await runCommand(["osascript", "-e", script, ...args], undefined, timeoutMs);
    const timedOut = r.timedOut || /AppleEvent timed out|-1712/i.test(r.err);
    return { out: timedOut ? "" : r.out, timedOut };
  } catch {
    return { out: "", timedOut: false };
  }
}

async function osascript(script: string, args: string[] = [], timeoutMs = OSASCRIPT_TIMEOUT_MS): Promise<string> {
  return (await osascriptResult(script, args, timeoutMs)).out;
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

// session_index に名前が無い codex セッション用: rollout の最初のユーザーメッセージから名前を作る
const codexAutoNames = new Map<string, string>();
function codexNameFor(sid: string, path?: string): string {
  const named = codexNames.get(sid);
  if (named) return named;
  const cached = codexAutoNames.get(sid);
  if (cached) return cached;
  const p = path ?? rolloutById(sid)?.path;
  if (!p) return sid;
  try {
    const fd = openSync(p, "r");
    const buf = Buffer.alloc(262_144);
    const n = readSync(fd, buf, 0, 262_144, 0);
    closeSync(fd);
    for (const line of buf.toString("utf8", 0, n).split("\n").slice(0, 80)) {
      let o: any; try { o = JSON.parse(line); } catch { continue; }
      const pl = o?.payload;
      if (o?.type === "response_item" && pl?.type === "message" && pl.role === "user") {
        const t = (typeof pl.content === "string" ? pl.content
          : Array.isArray(pl.content) ? pl.content.map((x: any) => x.text ?? "").join(" ") : "").trim();
        if (t && !t.startsWith("<")) {  // <environment_context> や <recommended_plugins> 等のシステム注入は除外
          const name = t.replace(/\s+/g, " ").slice(0, 50);
          codexAutoNames.set(sid, name);
          return name;
        }
      }
    }
  } catch {}
  codexAutoNames.set(sid, sid);  // 見つからなくても再走査しない
  return sid;
}

// ---------------------------------------------------------------- セッション収集
export type { PromptInfo };
export type GitInfo = { branch: string; dirty: number; ahead: number; behind: number };
export type Session = {
  key: string;            // agent:sid
  agent: "claude" | "codex";
  sid: string;
  name: string;
  title?: string;        // Claude アプリの表示名(ai-title)。あれば併記する
  cwd: string;
  status: string;         // busy | waiting | idle | resumable
  running: boolean;
  tty: string;            // ttysNNN ("" なら不明)
  pid?: number;
  ageS: number;           // 最終アクティビティからの秒数(概算)
  prompt?: PromptInfo;    // 画面から検出した選択プロンプト
  git?: GitInfo;
  stalled?: boolean;      // iTerm2 AppleScript がタイムアウトした tty は一時隔離する
  // 手元の tmux ペイン位置("work:3.0" 形式)。ブラウザを別マシンで開いていると
  // ジャンプが届かないため、代わりに attach コマンドを組み立てるのに使う。
  // 上の remote.target と違い、これは母艦自身で動いている tmux を指す
  tmuxTarget?: string;
  // ssh 越しの tmux ペイン。これがあるとキャプチャ・操作は remote 経由になる
  remote?: { host: string; paneId: string; target: string };
};

// `claude agents --json` はセッションが増えると 1 分前後かかることがある(実測 58〜88 秒)。
// poll() から同期的に呼ぶとポーリングごと詰まって一覧が空になるため、ssh の remote 系と
// 同じくキャッシュ + 独立タイマーに分離する。claudeRunning() はキャッシュを読むだけ。
let lastClaudeRunning: { at: number; list: Session[] } = { at: 0, list: [] };
const CLAUDE_RUNNING_STALE_MS = 300_000;  // 取得に 1 分かかるので短いと表示が点滅する
let claudeRefreshInFlight = false;
let lastSlowAgentsWarn = 0;

function claudeRunning(): Session[] {
  return Date.now() - lastClaudeRunning.at < CLAUDE_RUNNING_STALE_MS
    ? lastClaudeRunning.list : [];
}

async function refreshClaudeRunning(): Promise<void> {
  // 取得が 1 分かかる環境では、素朴なタイマーだと何十個も並走して事態が悪化する
  if (claudeRefreshInFlight) return;
  claudeRefreshInFlight = true;
  try {
    await refreshClaudeRunningInner();
  } finally {
    claudeRefreshInFlight = false;
  }
}

async function refreshClaudeRunningInner(): Promise<void> {
  const t0 = Date.now();
  const out = await sh(["claude", "agents", "--json"]);
  const elapsed = Date.now() - t0;
  // 遅いときだけ知らせる。毎回出すと遅い環境ではログが埋まる
  if (elapsed >= 5000 && Date.now() - lastSlowAgentsWarn > 60_000) {
    lastSlowAgentsWarn = Date.now();
    console.log(`claude agents: ${(elapsed / 1000).toFixed(1)}s (遅延。セッション数が多い可能性)`);
  }
  let arr: any[] = [];
  try { arr = JSON.parse(out); } catch {
    // 一時的な失敗ではキャッシュを触らない(有効期限内なら前回値が使われる)
    return;
  }
  // 空の結果でキャッシュを潰さない。取得失敗と「本当に 0 件」は区別できないため、
  // 消えるべきセッションは下の ps フィルタと有効期限切れに任せる
  if (!arr.length) return;
  const pids = arr.map(a => a.pid).join(",");
  const psOut = await sh(["ps", "-o", "pid=,tty=", "-p", pids]);
  const ttyByPid = new Map<number, string>();
  for (const l of psOut.trim().split("\n")) {
    const m = l.trim().match(/^(\d+)\s+(\S+)/);
    if (m) ttyByPid.set(Number(m[1]), m[2] === "??" ? "" : m[2]);
  }
  // ps に出てこない pid は既に死んでいる。claude agents の情報が古い場合に
  // 「実行中なのに tty も画面も無い」カードが残り続けるのを防ぐ
  const alive = arr.filter(a => ttyByPid.has(a.pid));
  const list = alive.map(a => {
    let status: string = a.status ?? "idle";
    if (/wait|input|need/i.test(status)) status = "waiting";
    return {
      key: `claude:${a.sessionId}`,
      agent: "claude" as const,
      sid: a.sessionId,
      name: a.name || a.sessionId,
      // Claude アプリ側の表示名(ai-title)。識別名と併記する
      title: aiTitleForSid(a.sessionId),
      cwd: a.cwd,
      status,
      running: true,
      tty: ttyByPid.get(a.pid) ?? "",
      pid: a.pid,
      ageS: Math.max(0, Math.floor((Date.now() - a.startedAt) / 1000)),
    };
  });
  lastClaudeRunning = { at: Date.now(), list };
}

async function codexRunning(): Promise<Session[]> {
  const psOut = await sh(["ps", "-axo", "pid=,tty=,command="]);
  const procs: { pid: number; tty: string; sid: string }[] = [];
  for (const l of psOut.split("\n")) {
    const m = l.trim().match(/^(\d+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    const cmd = m[3];
    // codex は絶対パス(npm の vendor バイナリ)や `node .../bin/codex` の形でも起動する。
    // 実行ファイル名が codex であればよい。`codex exec`(非対話・agd の管理外)は除外する。
    const argv0 = cmd.split(/\s+/)[0];
    if (!/(^|\/)codex$/.test(argv0)) continue;
    // 対話セッションは必ず端末に紐づく。tty を持たないものは agd の管理対象外。
    // exec(非対話)のほか、ChatGPT アプリが常駐させる app-server / mcp-server /
    // code-mode-host なども入ってくるため、ここでまとめて弾く
    if (m[2] === "??") continue;
    if (/^\S*codex\s+(exec|e|app-server|mcp-server|exec-server|remote-control|completion|doctor)\b/.test(cmd)) continue;
    // `codex resume <sid>` / `codex fork <sid>` は sid がコマンドラインに出る。
    // cwd からの逆引きより確実なのでこちらを優先する。
    const sid = cmd.match(/\b(?:resume|fork)\s+([0-9a-fA-F-]{36})\b/)?.[1] ?? "";
    procs.push({ pid: Number(m[1]), tty: m[2] === "??" ? "" : m[2], sid });
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
  const out: Session[] = [];
  const seenSid = new Set<string>();
  // node ラッパーと実体バイナリが両方 ps に出るため、tty を持つ方を優先して
  // 同一セッションを二重に数えない。
  for (const p of [...procs].sort((a, b) => (b.tty ? 1 : 0) - (a.tty ? 1 : 0))) {
    const cwd = cwdByPid.get(p.pid);
    if (!cwd) continue;
    // resume/fork はコマンドラインの sid を信頼する。それ以外は cwd から逆引き
    const meta = (p.sid ? rolloutById(p.sid) : null) ?? rolloutByCwd(cwd);
    const sid = meta?.id ?? p.sid;
    if (sid && seenSid.has(sid)) continue;
    if (sid) seenSid.add(sid);
    const ageS = meta ? Math.max(0, Math.floor(now - meta.mtime)) : 0;
    out.push({
      key: `codex:${sid || `pid${p.pid}`}`,
      agent: "codex" as const,
      sid,
      name: meta ? codexNameFor(meta.id, meta.path) : `pid ${p.pid}`,
      cwd,
      status: meta && now - meta.mtime < BUSY_WINDOW_S ? "busy" : "idle",
      running: true,
      tty: p.tty,
      pid: p.pid,
      ageS,
    });
  }
  return out;
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
      title: aiTitleOf(c.path),
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
    name: codexNameFor(m.id, m.path), cwd: m.cwd,
    status: "resumable", running: false, tty: "",
    ageS: Math.max(0, Math.floor(now - m.mtime)),
  }));
}

// ---------------------------------------------------------------- 画面キャプチャ
// tmux の実体パス。GUI(app バンドル)から起動されると PATH が
// /usr/bin:/bin:/usr/sbin:/sbin まで削られ、Homebrew の tmux を見つけられない。
// 素の "tmux" だと tmux 内のセッションだけ画面が真っ白になるので実体を探して覚える。
const TMUX_CANDIDATES = ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"];
let tmuxBinCache: string | undefined;
function tmuxBin(): string {
  if (tmuxBinCache === undefined)
    tmuxBinCache = TMUX_CANDIDATES.find(p => { try { return statSync(p).isFile(); } catch { return false; } }) ?? "tmux";
  return tmuxBinCache;
}

async function tmuxPanes(): Promise<TmuxPane[]> {
  return parseTmuxPanes(await sh([tmuxBin(), "list-panes", "-a", "-F", TMUX_PANE_FORMAT]));
}

// ---- iTerm2 Python API ヘルパー(色付き画面取得。使えないときは AppleScript にフォールバック) ----
const itermScreens = new Map<string, { text: string; at: number }>();
const stalledTtys = new Map<string, number>();
const ITERM_STALL_MS = 60_000;
let itermHelperOk = false;
let helperProc: ReturnType<typeof Bun.spawn> | null = null;
const helperOps = new Map<number, (r: { ok: boolean; error?: string }) => void>();
let helperOpSeq = 0;

function isTtyStalled(tty: string): boolean {
  const until = stalledTtys.get(tty);
  if (!until) return false;
  if (until > Date.now()) return true;
  stalledTtys.delete(tty);
  console.log(`iterm2 tty ${tty}: stall cleared`);
  return false;
}

function markTtyStalled(tty: string) {
  const wasStalled = isTtyStalled(tty);
  stalledTtys.set(tty, Date.now() + ITERM_STALL_MS);
  if (!wasStalled) console.log(`iterm2 tty ${tty}: stalled 60s (osascript timeout)`);
}

// ヘルパー経由の操作(focus/send/key/close)。ms級で応答し Apple Events 渋滞と無縁。
// 使えないとき(未接続・タイムアウト)は null を返し、呼び元が AppleScript にフォールバックする
function helperOp(op: string, params: Record<string, unknown>): Promise<{ ok: boolean; error?: string } | null> {
  if (!itermHelperOk || !helperProc?.stdin) return Promise.resolve(null);
  return new Promise(res => {
    const id = ++helperOpSeq;
    helperOps.set(id, res);
    try {
      (helperProc!.stdin as any).write(JSON.stringify({ id, op, ...params }) + "\n");
      (helperProc!.stdin as any).flush?.();
    } catch { helperOps.delete(id); res(null); return; }
    setTimeout(() => { if (helperOps.delete(id)) res(null); }, 4000);
  });
}

function startItermHelper(retryMs = 5000) {
  const py = join(import.meta.dir, ".venv", "bin", "python");
  const script = join(import.meta.dir, "iterm_capture.py");
  if (!existsSync(py) || !existsSync(script)) return;
  try {
    const p = Bun.spawn([py, script], { stderr: "ignore", stdin: "pipe" });
    helperProc = p;
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
                else console.log("iterm2 helper: connected (color capture + ops)");
              } else if (msg.type === "op") {
                const cb = helperOps.get(msg.id);
                if (cb) { helperOps.delete(msg.id); cb({ ok: !!msg.ok, error: msg.error }); }
              }
            } catch {}
          }
        }
      } catch {}
      await p.exited;
      itermHelperOk = false;
      helperProc = null;
      console.error(`iterm2 helper exited — ${Math.round(retryMs / 1000)}s 後に再接続`);
      setTimeout(() => startItermHelper(Math.min(retryMs * 2, 60_000)), retryMs);
    })();
  } catch {}
}
startItermHelper();

const ITERM_SCREEN_PREFIX = "__AGD_SCREEN__";
const ITERM_CAPTURE_SCRIPT = `
on run argv
  set target to item 1 of argv
  with timeout of 2 seconds
    tell application "iTerm2"
      repeat with w in windows
        repeat with t in tabs of w
          repeat with s in sessions of t
            if tty of s is target then
              return "${ITERM_SCREEN_PREFIX}" & (text of s)
            end if
          end repeat
        end repeat
      end repeat
    end tell
  end timeout
  return ""
end run`;

// tty → tmux ペイン位置("work:3.0")。captureScreens が毎サイクル tmuxPanes() を
// 引くので、その結果をここに残して poll() から使い回す(list-panes を二度叩かないため)
const tmuxTargetByTty = new Map<string, string>();

// このホストに手元から ssh するときの宛先名。ポートフォワード越しに見ている
// ブラウザへ渡し、attach コマンドの ssh 先として使わせる。
// AGD_SSH_HOST で上書きできる(~/.ssh/config のエイリアスを使いたい場合など)。
let sshHostCache: string | undefined;
async function sshHostName(): Promise<string> {
  if (sshHostCache !== undefined) return sshHostCache;
  const env = (process.env.AGD_SSH_HOST || "").trim();
  if (env) return (sshHostCache = env);
  // 手元のマシンとこのホストでユーザー名が違うのが普通(Neo は hiroaki、
  // 母艦は HHosono)。名前だけ渡すと手元のユーザー名で ssh して弾かれるので
  // 必ず user@ を付ける。実際に Permission denied を踏んだ
  const user = (await sh(["/usr/bin/id", "-un"])).trim();
  const at = user ? `${user}@` : "";
  // ローカル名(.local)より tailnet 名の方が外から届きやすいので優先する
  const ts = (await sh(["/bin/sh", "-c",
    "tailscale status --json 2>/dev/null | /usr/bin/python3 -c "
    + "'import json,sys;print(json.load(sys.stdin)[\"Self\"][\"DNSName\"].split(\".\")[0])' 2>/dev/null"])).trim();
  if (ts) return (sshHostCache = at + ts);
  const hn = (await sh(["hostname", "-s"])).trim();
  return (sshHostCache = hn ? at + hn : "localhost");
}

async function captureScreens(ttys: string[]): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const panes = await tmuxPanes();
  const paneByTty = new Map(panes.map(p => [p.tty, p]));
  tmuxTargetByTty.clear();
  // target は "work:3.0" 形式のまま保持する。セッション名だけだと attach 後に
  // 「最後に見ていたウィンドウ」が開いてしまい、目的のペインに着かない
  for (const p of panes) if (p.target) tmuxTargetByTty.set(p.tty, p.target);
  const need = new Set(ttys.filter(Boolean));
  // tmux ペインは capture-pane で
  const tmuxTargets = [...need].filter(t => paneByTty.has(t));
  await Promise.all(tmuxTargets.map(async t => {
    const p = paneByTty.get(t)!;
    // 遡る行数。カード内を上にスクロールして過去の出力を追えるようにする
    const text = await sh([tmuxBin(), "capture-pane", "-p", "-e", "-t", p.paneId, "-S", `-${SCROLLBACK}`]);
    if (text) result.set(t, text.trimEnd());
  }));
  // tmux 以外でタイムアウトした tty だけを一時除外し、他の Apple Events を巻き添えにしない
  const itermNeed = [...need].filter(t => !paneByTty.has(t) && !isTtyStalled(t));
  // Python API ヘルパーの新鮮なデータがあれば優先(色付き)
  for (const t of itermNeed) {
    if (result.has(t)) continue;
    const cached = itermScreens.get(t);
    if (cached && Date.now() - cached.at < 15_000) result.set(t, cached.text);
  }
  // AppleScript 取得はヘルパーが死んでいるときだけのフォールバック。
  // ヘルパー稼働中に毎サイクル併走させると iTerm2 の Apple Events が渋滞し、
  // フォーカスやキー送信まで遅くなる(iTerm2外のターミナルはどのみち取得不能)
  if (!itermHelperOk) {
    // 一括取得だと停止 tty を特定できないため直列に取得し、その tty だけを隔離する
    for (const tty of itermNeed) {
      if (result.has(tty)) continue;
      const r = await osascriptResult(ITERM_CAPTURE_SCRIPT, [`/dev/${tty}`]);
      if (r.timedOut) {
        markTtyStalled(tty);
        continue;
      }
      if (r.out.startsWith(ITERM_SCREEN_PREFIX))
        result.set(tty, r.out.slice(ITERM_SCREEN_PREFIX.length).trimEnd());
    }
  }
  return result;
}


// ---------------------------------------------------------------- git 情報(15秒キャッシュ)
const gitCache = new Map<string, { info: GitInfo | null; at: number }>();
async function gitInfo(cwd: string): Promise<GitInfo | null> {
  const c = gitCache.get(cwd);
  if (c && Date.now() - c.at < 30_000) return c.info;
  // -uno: 未追跡ファイルの走査を省く(大リポジトリで status が数秒かかるのを防ぐ)
  const out = await sh(["git", "-C", cwd, "status", "--porcelain", "--branch", "-uno"]);
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
let config: { macNotify: boolean; summarize?: boolean; remotes?: RemoteHost[] } =
  { macNotify: false, summarize: true, remotes: [] };
try { config = { ...config, ...JSON.parse(readFileSync(CONFIG_PATH, "utf8")) }; } catch {}
if (!Array.isArray(config.remotes)) config.remotes = [];
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
  console.log(`macos notify: ${title}`);
}

// ---------------------------------------------------------------- 入力送信 / フォーカス / resume
const ITERM_WRITE_SCRIPT = `
on run argv
  set target to item 1 of argv
  set msg to item 2 of argv
  with timeout of 2 seconds
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
  end timeout
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
    await sh([tmuxBin(), "send-keys", "-t", pane.paneId, "-l", payload]);
    await Bun.sleep(150);
    await sh([tmuxBin(), "send-keys", "-t", pane.paneId, "Enter"]);
    return "ok(tmux)";
  }
  const viaApi = await helperOp("send", { tty, text });
  if (viaApi) return viaApi.ok ? "ok(api)" : "error: " + (viaApi.error ?? "helper");
  if (isTtyStalled(tty)) return "error: timeout";
  const r = await shStrict(["osascript", "-", `/dev/${tty}`, "text", payload], ITERM_KEY_SCRIPT, OSASCRIPT_TIMEOUT_MS);
  if (r === "error: timeout") markTtyStalled(tty);
  if (!r.startsWith("ok")) return r;
  await Bun.sleep(150);
  const enter = await shStrict(["osascript", "-", `/dev/${tty}`, "enter", ""], ITERM_KEY_SCRIPT, OSASCRIPT_TIMEOUT_MS);
  if (enter === "error: timeout") markTtyStalled(tty);
  return enter;
}

// 生キー送信(数字選択・y/n・Enter・Esc)。Enter を付けない
const ITERM_KEY_SCRIPT = `
on run argv
  set theTarget to item 1 of argv
  set theKind to item 2 of argv
  set thePayload to item 3 of argv
  with timeout of 2 seconds
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
  end timeout
  return "not found"
end run`;

// Space は設定フォームのチェックボックス切り替えに要る。名前付きで扱わないと
// send-keys -l で "Space" という文字列がそのまま打ち込まれる
const NAMED_KEYS = new Set(["Enter", "Escape", "Up", "Down", "Left", "Right", "Tab", "ShiftTab", "Space"]);
const CSI_MAP: Record<string, string> = { Up: "A", Down: "B", Right: "C", Left: "D", ShiftTab: "Z" };

async function sendKeyToTty(tty: string, key: string): Promise<string> {
  const panes = await tmuxPanes();
  const pane = panes.find(p => p.tty === tty);
  if (pane) {
    if (key === "ShiftTab") await sh([tmuxBin(), "send-keys", "-t", pane.paneId, "BTab"]);
    else if (NAMED_KEYS.has(key)) await sh([tmuxBin(), "send-keys", "-t", pane.paneId, key]);
    else await sh([tmuxBin(), "send-keys", "-t", pane.paneId, "-l", key]);
    return "ok(tmux)";
  }
  const viaApi = await helperOp("key", { tty, keys: [key] });
  if (viaApi) return viaApi.ok ? "ok(api)" : "error: " + (viaApi.error ?? "helper");
  let kind = "text", payload = key;
  if (key === "Enter") kind = "enter";
  else if (key === "Escape") kind = "escape";
  else if (key === "Tab") kind = "tab";
  else if (key === "Space") payload = " ";   // text として空白1文字を打つ
  else if (CSI_MAP[key]) { kind = "csi"; payload = CSI_MAP[key]; }
  if (isTtyStalled(tty)) return "error: timeout";
  const r = await shStrict(["osascript", "-", `/dev/${tty}`, kind, payload], ITERM_KEY_SCRIPT, OSASCRIPT_TIMEOUT_MS);
  if (r === "error: timeout") markTtyStalled(tty);
  return r;
}

// stderr も見て AppleScript エラーを表面化させる版
async function shStrict(cmd: string[], input?: string, timeoutMs?: number): Promise<string> {
  try {
    const r = await runCommand(cmd, input, timeoutMs);
    if (r.timedOut || /AppleEvent timed out|-1712/i.test(r.err)) return "error: timeout";
    if (r.out.trim()) return r.out.trim();
    if (r.err.trim()) return "error: " + r.err.trim().split("\n")[0].slice(0, 200);
    return "ok";
  } catch (e: any) {
    return "error: " + (e?.message ?? String(e));
  }
}

// キー列を順に送る(カーソル選択: Down×n → Enter など)
async function sendKeysToTty(tty: string, keys: string[]): Promise<string> {
  const seq = keys.slice(0, 20);
  // tmux ペインでなければヘルパーに列ごと渡す(1往復・タイミングはヘルパー側で管理)
  const panes = await tmuxPanes();
  if (!panes.some(p => p.tty === tty)) {
    const viaApi = await helperOp("key", { tty, keys: seq });
    if (viaApi) return viaApi.ok ? "ok(api)" : "error: " + (viaApi.error ?? "helper");
  }
  let last = "ok";
  for (const k of seq) {
    last = await sendKeyToTty(tty, k);
    if (last === "error: timeout") break;
    await Bun.sleep(120);
  }
  return last;
}

// セッション終了(タブ/ペインを閉じる)
const ITERM_CLOSE_SCRIPT = `
on run argv
  set theTarget to item 1 of argv
  with timeout of 2 seconds
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
  end timeout
  return "not found"
end run`;

async function closeTty(tty: string): Promise<string> {
  const panes = await tmuxPanes();
  const pane = panes.find(p => p.tty === tty);
  if (pane) {
    await sh([tmuxBin(), "kill-pane", "-t", pane.paneId]);
    return "ok(tmux)";
  }
  const viaApi = await helperOp("close", { tty });
  if (viaApi) return viaApi.ok ? "ok(api)" : "error: " + (viaApi.error ?? "helper");
  return shStrict(["osascript", "-", `/dev/${tty}`], ITERM_CLOSE_SCRIPT, OSASCRIPT_TIMEOUT_MS);
}

const ITERM_FOCUS_SCRIPT = `
on run argv
  set target to item 1 of argv
  with timeout of 2 seconds
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
  end timeout
  return "not found"
end run`;

async function focusTty(tty: string): Promise<string> {
  const viaApi = await helperOp("focus", { tty });
  if (viaApi) return viaApi.ok ? "ok(api)" : "not found";
  const r = await sh(["osascript", "-", `/dev/${tty}`], ITERM_FOCUS_SCRIPT, OSASCRIPT_TIMEOUT_MS);
  return r.trim();
}

// 注意: activate は入れない(起動のたびにブラウザからフォーカスを奪わないため)。
// ターミナルへ移動したいときは ⌖/f のジャンプ(focus API)を使う
const ITERM_NEWTAB_SCRIPT = `
on run argv
  set cmd to item 1 of argv
  with timeout of 2 seconds
    tell application "iTerm2"
      if (count of windows) is 0 then
        create window with default profile
      else
        tell current window to create tab with default profile
      end if
      tell current session of current window to write text cmd
    end tell
  end timeout
end run`;

// ---- tmux 内で起動する ----
// 素の tty で起動すると外(Neo/iPhone 等)から attach できない。tmux 内なら
// 切断してもセッションが残り、外出先の端末から attach して続きを触れる。
// AGD_TMUX=0 で従来どおり素の tty 起動に戻せる。
const USE_TMUX = !/^(0|false|no)$/i.test(process.env.AGD_TMUX || "");
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

// tmux が実在するか。PATH は当てにならないので tmuxBin() の解決結果で判断する
function hasTmux(): boolean { return tmuxBin() !== "tmux"; }

// tmux セッション名。ペイン単位で使い捨てるのではなく、agd から起こしたものは
// agd-<連番> という独立セッションにする(名前が衝突すると attach 先が紛れるため)
let tmuxSeq = 0;
function nextTmuxName(): string {
  // 秒 + 連番。再起動をまたいでも既存名と当たりにくい
  return `agd-${Math.floor(Date.now() / 1000).toString(36)}${(tmuxSeq++).toString(36)}`;
}

// agent 起動コマンドを tmux 内で走らせる形に包む。
// 終了後すぐペインが消えると落ちた理由が読めないので、シェルを残して確認できるようにする
function wrapTmux(inner: string, name = nextTmuxName()): string {
  if (!USE_TMUX || !hasTmux()) return inner;
  // 起動されるターミナル側も PATH が細い場合があるため tmux は絶対パスで呼ぶ
  return `${tmuxBin()} new-session -s ${shq(name)} ${shq(inner + "; exec $SHELL")}`;
}

// iTerm を経由せず、tmux セッションだけを detached で起こす。
//
// GUI ログインしていない(ヘッドレス)環境では iTerm が起動できず、
// AppleScript の "create window" が用語辞書を引けずに構文エラーになる。
// 見えるタブは作れないが、agd が扱うのは tmux セッションなので、
// detached で起こせば一覧にも出るし送信・画面取得もできる。
async function openDetachedTmux(inner: string): Promise<string> {
  if (!hasTmux()) return "error: tmux が無いため端末を開けません";
  const name = nextTmuxName();
  // -d で作ると tmux は default-size(既定 80x24)を使う。TUI はその幅で
  // 描画するため、あとから広い端末で attach しても入力欄が画面外に出たままになる
  // (実測: 80x24 のまま追従しない)。作成時に広めに取り、window-size latest で
  // 以後は attach したクライアントに合わせる
  const r = await runCommand([tmuxBin(), "new-session", "-d", "-s", name,
    "-x", "200", "-y", "50", `${inner}; exec $SHELL`]);
  await sh([tmuxBin(), "set-option", "-t", name, "window-size", "latest"]);
  if (r.err.trim()) return "error: " + r.err.trim().split("\n")[0].slice(0, 200);
  return `ok(tmux:${name})`;
}

// 端末で起動する。GUI が使えるなら iTerm に新規タブ、駄目なら tmux detached。
// 呼び出し側から見た成否の伝え方は同じ("ok…" か "error: …")
async function openInTerminal(inner: string): Promise<string> {
  const r = await shStrict(["osascript", "-", wrapTmux(inner)], ITERM_NEWTAB_SCRIPT, OSASCRIPT_TIMEOUT_MS);
  if (!r.startsWith("error")) return r;
  const fallback = await openDetachedTmux(inner);
  // どちらも駄目なら、最初の(より原因に近い)エラーを返す
  return fallback.startsWith("error") ? r : fallback;
}

// fork=true: 会話履歴を引き継ぎつつ新しいセッションIDに分岐する。
// 素の resume で複製すると両プロセスが同一トランスクリプトに追記してログが交錯するため、
// 実行中セッションの複製(Ctrl+C)は必ず fork を使う
async function openResume(agent: string, sid: string, cwd: string, fork = false): Promise<string> {
  const q = shq;
  const inner = agent === "claude"
    ? `cd ${q(cwd)} && claude --resume ${sid}${fork ? " --fork-session" : ""}`
    : `cd ${q(cwd)} && codex ${fork ? "fork" : "resume"} ${sid}`;
  return await openInTerminal(inner);
}

// ---------------------------------------------------------------- トランスクリプト解析は transcript.ts へ移設

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

// Claude アプリ(Remote Control 等)に出る表示名。トランスクリプトに
// {"type":"ai-title","aiTitle":"…"} として記録される。会話が進むと更新される
// ため、最後に現れたものを採用する。mtime が変わるまでは再走査しない。
const aiTitleCache = new Map<string, { mtime: number; title: string }>();
function aiTitleOf(path: string): string {
  let st;
  try { st = statSync(path); } catch { return ""; }
  const c = aiTitleCache.get(path);
  if (c && c.mtime === st.mtimeMs) return c.title;
  let title = "";
  try {
    // ai-title 行はファイル末尾側に付くので、後ろから 512KB だけ見る。
    // 先頭が途中で切れても行単位で捨てるので問題ない。
    const TAIL = 512 * 1024;
    const start = Math.max(0, st.size - TAIL);
    const fd = openSync(path, "r");
    const buf = Buffer.alloc(st.size - start);
    readSync(fd, buf, 0, buf.length, start);
    closeSync(fd);
    for (const line of buf.toString("utf8").split("\n")) {
      if (!line.includes('"ai-title"')) continue;
      try {
        const o = JSON.parse(line);
        if (o?.type === "ai-title" && typeof o.aiTitle === "string" && o.aiTitle.trim())
          title = o.aiTitle.trim();       // 最後に見つかったものが最新
      } catch {}
    }
  } catch {}
  aiTitleCache.set(path, { mtime: st.mtimeMs, title });
  return title;
}

// 未応答の AskUserQuestion をトランスクリプトから取る。画面解析より確実で
// description も取れるため、取れた場合はこちらを優先する。
// ai-title と同じく末尾だけ読み、mtime が変わらなければ再走査しない
const askCache = new Map<string, { mtime: number; prompt: PromptInfo | null }>();
function askPromptForSid(sid: string): PromptInfo | null {
  const path = findClaudeTranscript(sid);
  if (!path) return null;
  let st;
  try { st = statSync(path); } catch { return null; }
  const c = askCache.get(path);
  if (c && c.mtime === st.mtimeMs) return c.prompt;
  let prompt: PromptInfo | null = null;
  try {
    // 質問と応答は近接して現れるので末尾だけで足りる
    const TAIL = 512 * 1024;
    const start = Math.max(0, st.size - TAIL);
    const fd = openSync(path, "r");
    const buf = Buffer.alloc(st.size - start);
    readSync(fd, buf, 0, buf.length, start);
    closeSync(fd);
    prompt = detectAskPrompt(buf.toString("utf8").split("\n"));
  } catch {}
  askCache.set(path, { mtime: st.mtimeMs, prompt });
  return prompt;
}

// sid だけ分かっている場合(実行中セッション)の表示名解決
function aiTitleForSid(sid: string): string {
  const p = findClaudeTranscript(sid);
  return p ? aiTitleOf(p) : "";
}

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
      name = codexNameFor(f.sid, f.path);
    }
    hits.push({ agent: f.agent, sid: f.sid, name, cwd, mtime: f.mtime, count, snippet });
  }));
  hits.sort((a, b) => b.mtime - a.mtime);
  return hits;
}

// ---------------------------------------------------------------- 検索・要約 Worker
// SQLite/FTS/LLM要約は search-worker.ts(別スレッド)で実行し、メインの
// イベントループ(HTTP/ポーリング)を決してブロックさせない。
const INDEX_DAYS = Number(process.env.AGD_INDEX_DAYS || 14);
type IndexTarget = { path: string; agent: "claude" | "codex"; sid: string; mtime: number };
function indexTargets(): IndexTarget[] {
  const cutoff = Date.now() - INDEX_DAYS * 86400_000;
  const out: IndexTarget[] = [];
  try {
    for (const d of readdirSync(CLAUDE_PROJECTS)) {
      const dir = join(CLAUDE_PROJECTS, d);
      let fs2: string[] = [];
      try { fs2 = readdirSync(dir).filter(f => f.endsWith(".jsonl")); } catch { continue; }
      for (const f of fs2) {
        try {
          const st = statSync(join(dir, f));
          if (st.mtimeMs > cutoff) out.push({ path: join(dir, f), agent: "claude", sid: f.replace(/\.jsonl$/, ""), mtime: st.mtimeMs });
        } catch {}
      }
    }
  } catch {}
  for (const m of rolloutCache.values())
    if (m.id && m.mtime * 1000 > cutoff) out.push({ path: m.path, agent: "codex", sid: m.id, mtime: m.mtime * 1000 });
  return out.sort((a, b) => b.mtime - a.mtime);
}

const baseKey = (k: string) => k.split("#")[0];
const summariesMap = new Map<string, string>();
let workerReady = false;
let workerProgress = { done: 0, total: 0 };
const searchPending = new Map<number, (hits: any[] | null) => void>();
let searchSeq = 0;

// Worker は死にうる(DB の I/O エラー等)。死んだまま放置すると要約・検索が
// 永久に止まり、postMessage が毎ポーリング例外になるので、自動で作り直す。
let searchWorker: Worker;
let workerDeadAt = 0;

function spawnWorker() {
  const w = new Worker(new URL("./search-worker.ts", import.meta.url).href);
  w.onmessage = (e: MessageEvent) => {
    const m = e.data;
    if (m.type === "ready") { workerReady = true; console.log(`search index ready: ${m.files} files`); }
    else if (m.type === "progress") workerProgress = { done: m.done, total: m.total };
    else if (m.type === "summariesAll") { for (const s of m.list) summariesMap.set(s.key, s.text); }
    else if (m.type === "summary") summariesMap.set(m.key, m.text);
    else if (m.type === "searchResult") { searchPending.get(m.id)?.(m.hits); searchPending.delete(m.id); }
    else if (m.type === "log") console.log("worker:", m.msg);
  };
  w.onerror = (e: any) => { console.error("worker error:", e?.message ?? e); markWorkerDead(); };
  const anyW = w as any;
  if (typeof anyW.addEventListener === "function")
    anyW.addEventListener("close", () => markWorkerDead());
  searchWorker = w;
}

function markWorkerDead() {
  if (workerDeadAt) return;           // 再起動待ちの間は多重に走らせない
  workerDeadAt = Date.now();
  workerReady = false;
  for (const [id, res] of searchPending) { res(null); searchPending.delete(id); }
  // 即再起動すると死因(DB破損など)を繰り返すだけなので少し待つ
  setTimeout(() => {
    workerDeadAt = 0;
    console.log("search worker を再起動します");
    spawnWorker();
    sendReindex();
  }, 30_000);
}

// postMessage が「terminated」で投げたら死亡確定として再起動を仕掛ける
function workerPost(msg: unknown): boolean {
  try { searchWorker.postMessage(msg); return true; }
  catch { markWorkerDead(); return false; }
}

spawnWorker();

function sendReindex() { workerPost({ type: "reindex", targets: indexTargets() }); }
setTimeout(sendReindex, 3000);
setInterval(sendReindex, 5 * 60_000);

function workerSearch(q: string): Promise<any[] | null> {
  return new Promise(res => {
    const id = ++searchSeq;
    searchPending.set(id, res);
    if (!workerPost({ type: "search", id, q })) { searchPending.delete(id); return res(null); }
    setTimeout(() => { if (searchPending.delete(id)) res(null); }, 15_000);
  });
}

// 要約リクエスト。throttled=true(起動時の埋め合わせ)は10分に1回まで
const sumAttempted = new Map<string, number>();
function requestSummary(key: string, force = false, throttled = false) {
  if (config.summarize === false) return;
  const k = baseKey(key);
  if (throttled && !force && Date.now() - (sumAttempted.get(k) ?? 0) < 10 * 60_000) return;
  sumAttempted.set(k, Date.now());
  const [agent, sid] = k.split(":") as ["claude" | "codex", string];
  if (!sid) return;
  const path = agent === "claude" ? findClaudeTranscript(sid) : rolloutById(sid)?.path;
  if (path) workerPost({ type: "summarize", key: k, path, agent, force });
}

// Worker の生ヒットに名前・cwd を付与(メイン側のメタ情報を使う)
function enrichHits(raw: { path: string; agent: string; sid: string; mtime: number; count: number; snippet: string }[]): SearchHit[] {
  return raw.map(h => {
    let cwd = "", name = "";
    if (h.agent === "claude") {
      try { cwd = readFileSync(h.path, "utf8").slice(0, 200_000).match(/"cwd":"([^"]+)"/)?.[1] ?? ""; } catch {}
      name = claudeNameFor(h.sid, h.path);
    } else {
      cwd = rolloutById(h.sid)?.cwd ?? "";
      name = codexNameFor(h.sid, h.path);
    }
    return { agent: h.agent, sid: h.sid, name, cwd, mtime: h.mtime, count: h.count, snippet: h.snippet };
  });
}

// ---------------------------------------------------------------- 新規セッション起動
async function openNew(agent: string, cwd: string): Promise<string> {
  const inner = `cd ${shq(cwd)} && ${agent === "codex" ? "codex" : "claude"}`;
  // sh() は終了コードも stderr も捨てるため、iTerm が開けなくても "ok" を
  // 返していた(GUI ログインしていないヘッドレス環境では必ず失敗する)
  return await openInTerminal(inner);
}

// リモートの tmux セッションに attach する新規タブを開く。
// これがあるとリモートのカードからも f(ジャンプ)が使えるようになる。
async function openRemoteAttach(h: RemoteHost, tmuxSession: string): Promise<string> {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const path = h.path ?? "$HOME/.local/bin";
  // リモート側の PATH を通してから attach(非対話シェルは .bashrc を読まないため)
  const inner = `export PATH=${path}:$PATH; tmux attach -t ${q(tmuxSession)}`;
  const cmd = `ssh ${q(h.host)} -t ${q(inner)}`;
  // openNew と同じ理由で shStrict を使う(失敗を "ok" として返さない)
  return await shStrict(["osascript", "-", cmd], ITERM_NEWTAB_SCRIPT, OSASCRIPT_TIMEOUT_MS);
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

// フロント資産の版。更新するとクライアントが自動リロードする。
// agd.app(WKWebView)は独自キャッシュを持ち手動リロード手段も限られるため、
// 「サーバーだけ更新してUIが古いまま」という事故を防ぐ。
function assetVersion(): string {
  let v = 0;
  for (const f of ["app.js", "i18n.js", "core.js", "mobile.js", "index.html", "m.html"]) {
    try { v = Math.max(v, statSync(join(import.meta.dir, "public", f)).mtimeMs); } catch {}
  }
  return String(Math.floor(v));
}
const ASSET_VERSION = assetVersion();
let lastSnapshot: Snapshot = { sessions: [], at: 0 };
const keyAssign = new Map<string, string>();  // "agent:sid:pid" → 確定済みカードキー
const prevStatus = new Map<string, string>();
const wsClients = new Set<any>();

// ---------------------------------------------------------------- リモート(ssh + tmux)
// ssh は往復が読めないためメインのポーリングとは分離し、独立タイマーで
// キャッシュを更新する。poll() はキャッシュを読むだけなので遅延に巻き込まれない。
type RemoteSession = Session & { screen?: string };
const remoteCache = new Map<string, { list: RemoteSession[]; at: number }>();
const REMOTE_POLL_MS = 5000;
const REMOTE_STALE_MS = 60_000;   // これを超えて更新できないホストは一覧から落とす

function remoteHosts(): RemoteHost[] { return config.remotes ?? []; }
function remoteHostOf(host: string): RemoteHost | undefined {
  return remoteHosts().find(h => h.host === host);
}
function remoteCacheList(): RemoteSession[] {
  const now = Date.now();
  const out: RemoteSession[] = [];
  for (const [host, v] of remoteCache) {
    if (now - v.at > REMOTE_STALE_MS) continue;
    if (!remoteHostOf(host)) continue;   // 設定から消えたホストは出さない
    out.push(...v.list);
  }
  return out;
}

// カードキーから remote 情報を引く。操作系 API はまずこれを見て、
// 該当すれば ssh 経由に振り分ける(リモートは tty を持たないため)
// 手元のターミナルで `ssh <host> ... tmux attach -t <session>` を開いていれば、
// その tty にフォーカスすればリモートの画面が見られる。f(ジャンプ)を
// リモートでも成立させるため、ローカルの ssh プロセスから対応表を作る。
type SshAttach = { host: string; tmuxSession: string; tty: string };
let sshAttachCache: { at: number; list: SshAttach[] } = { at: 0, list: [] };

async function sshAttachments(): Promise<SshAttach[]> {
  if (Date.now() - sshAttachCache.at < 3000) return sshAttachCache.list;
  const out = await sh(["ps", "-axo", "pid=,tty=,command="]);
  const list: SshAttach[] = [];
  for (const l of out.split("\n")) {
    const m = l.trim().match(/^(\d+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    const [, , tty, cmd] = m;
    if (tty === "??" || !/(^|\/)ssh\s/.test(cmd)) continue;   // tty を持つ対話 ssh だけ
    // 宛先は最初の非オプション引数。-o foo / -t のようなフラグは読み飛ばす
    const toks = cmd.split(/\s+/).slice(1);
    let host = "";
    for (let i = 0; i < toks.length; i++) {
      const tk = toks[i];
      if (tk === "-o" || tk === "-i" || tk === "-p" || tk === "-l" || tk === "-F") { i++; continue; }
      if (tk.startsWith("-")) continue;
      host = tk.replace(/^.*@/, "");
      break;
    }
    if (!host) continue;
    // -t の値はクォートされることがある('ops' / "ops" / ops)
    const sess = cmd.match(/tmux\s+(?:attach|attach-session|a)\b[^\n]*?-t\s+['"]?([A-Za-z0-9_.-]+)['"]?/)?.[1] ?? "";
    list.push({ host, tmuxSession: sess, tty });
  }
  sshAttachCache = { at: Date.now(), list };
  return list;
}

// リモートセッションに対応するローカル tty を返す(無ければ null)。
// tmux セッション名まで一致するものを優先し、無ければ同ホストの ssh を使う。
async function localTtyForRemote(host: string, target: string): Promise<string | null> {
  const want = target.split(":")[0];              // "consult:0.0" → "consult"
  const list = (await sshAttachments()).filter(a => a.host === host);
  return list.find(a => a.tmuxSession === want)?.tty ?? list.find(a => !a.tmuxSession)?.tty ?? null;
}

// sid からリモートホストを引く(トランスクリプト取得用)。
// リモートの sid はローカルに存在しないので、これで先に振り分ける。
function remoteHostBySid(sid: string): RemoteHost | null {
  if (!sid) return null;
  for (const v of remoteCache.values()) {
    const s = v.list.find(x => x.sid === sid && x.remote);
    if (s?.remote) return remoteHostOf(s.remote.host) ?? null;
  }
  return null;
}

function remoteOf(key: string): { h: RemoteHost; paneId: string } | null {
  if (!key) return null;
  for (const v of remoteCache.values()) {
    const s = v.list.find(x => x.key === key);
    if (s?.remote) {
      const h = remoteHostOf(s.remote.host);
      if (h) return { h, paneId: s.remote.paneId };
    }
  }
  return null;
}

let remotePolling = false;
async function pollRemotes() {
  if (remotePolling) return;
  const hosts = remoteHosts();
  if (!hosts.length) return;
  remotePolling = true;
  try {
    await Promise.all(hosts.map(async h => {
      try {
        const list: RemoteSession[] = await remoteSessions(h);
        // 画面も同時に取っておく(カード表示のたびに ssh を張らないため)
        await Promise.all(list.map(async s => {
          if (!s.remote) return;
          const text = await remoteCapture(h, s.remote.paneId);
          if (!text) return;
          s.screen = text.trimEnd();
          // waiting への昇格条件はローカルと揃える(カーソルだけの誤検出を防ぐ)
          const p = detectPrompt(s.screen);
          if (!p) return;
          s.prompt = p;
          const confident = p.kind === "numbered" || (s.agent === "codex" && p.kind === "cursor");
          if (confident && s.status === "idle") s.status = "waiting";
        }));
        remoteCache.set(h.host, { list, at: Date.now() });
      } catch (e: any) {
        console.error(`remote ${h.host}: ${e?.message ?? e}`);
      }
    }));
  } finally { remotePolling = false; }
}

// 同一セッションIDを複数プロセスで開いている場合(resume引き継ぎ直後など)のキー衝突対策。
// 重要: 一度プロセス(pid)に割り当てたキーは、そのプロセスが生きている限り変えない。
// (元プロセス終了時に新プロセスのキーが SID#PID → SID に変わると、カードの同一性が
//  飛んで位置・選択・表示が入れ替わったように見えるため)
function assignStableKeys(running: Session[]) {
  const live = new Set(running.map(s => `${s.agent}:${s.sid}:${s.pid}`));
  for (const k of keyAssign.keys()) if (!live.has(k)) keyAssign.delete(k);
  const groups = new Map<string, Session[]>();
  for (const s of running) {
    const g = groups.get(s.key);
    if (g) g.push(s); else groups.set(s.key, [s]);
  }
  for (const g of groups.values()) {
    const used = new Set<string>();
    // 既に割当済みのプロセスはそのキーを維持
    for (const s of g) {
      const id = `${s.agent}:${s.sid}:${s.pid}`;
      const prior = keyAssign.get(id);
      if (prior) { s.key = prior; used.add(prior); }
    }
    // 未割当は「最古がベースキー(空いていれば)、それ以外は #pid」
    const unassigned = g.filter(s => !keyAssign.has(`${s.agent}:${s.sid}:${s.pid}`))
      .sort((a, b) => (b.ageS - a.ageS) || ((a.pid ?? 0) - (b.pid ?? 0)));
    for (const s of unassigned) {
      const base = s.key;
      const assigned = used.has(base) ? `${base}#${s.pid ?? 0}` : base;
      s.key = assigned;
      used.add(assigned);
      keyAssign.set(`${s.agent}:${s.sid}:${s.pid}`, assigned);
    }
  }
}

// 長時間ログ更新の無い claude の busy はゾンビ表示とみなして idle に補正(#4)。
// 長いツール実行中(書き込みなし)の誤判定を避けるため閾値は10分と長めに取る
function fixZombieBusy(running: Session[]) {
  for (const s of running) {
    if (s.agent !== "claude" || s.status !== "busy") continue;
    const p = findClaudeTranscript(s.sid);
    if (!p) continue;
    try { if (Date.now() - statSync(p).mtimeMs > 10 * 60_000) s.status = "idle"; } catch {}
  }
}

// 画面から選択プロンプトを検出。codex はこれで waiting 判定も行う
function applyPrompts(running: Session[], screens: Map<string, string>) {
  for (const s of running) {
    const p = detectPrompt(screens.get(s.tty));
    // AskUserQuestion はトランスクリプトに構造化されて残る。ラベルが幅で切れず、
    // 横並びパネルの文字も混ざらず、description と multiSelect まで取れるので、
    // 取れた場合は常にこちらを正とする。
    //
    // ただし「画面にも選択プロンプトが出ている」ことは条件に残す。転記だけを
    // 根拠にすると、応答直後でまだ tool_result が書かれていない一瞬に、待機して
    // いないセッションへボタンを出してしまう(実際に踏んだ)。
    const ask = s.agent === "claude" && p?.options.length ? askPromptForSid(s.sid) : null;
    // 選択の実行はキー送信なので、カーソル位置だけは画面の値を使う。
    //
    // 画面がスクロールしていたり幅が狭いと、見えている選択肢が転記より少ない
    // ことがある。以前は件数一致を条件にしていたため、その場合に転記を捨てて
    // 幅切れしたラベルを使っていた。件数がずれてもラベルは転記が正しいので採る。
    // ただしカーソル位置は「画面に見えている範囲での位置」なので、転記の件数に
    // 対して外れることがある。範囲外なら先頭に倒す(誤った行を選ぶより安全)
    const cursor = p?.cursorIndex ?? 0;
    const merged = ask
      ? { ...ask, cursorIndex: cursor < ask.options.length ? cursor : 0 }
      : p;
    if (!merged) continue;
    s.prompt = merged;
    // 誤検出防止: waiting への昇格は「番号付き選択肢」または「codexのカーソル選択」のみ
    const confident = merged.kind === "numbered" || (s.agent === "codex" && merged.kind === "cursor");
    if (confident && s.status === "idle") s.status = "waiting";
  }
}

type StatusChange = { key: string; name: string; agent: string; from: string; to: string; tty: string };

// 前回スナップショットとの状態差分。通知と要約の起点になる
function detectChanges(running: Session[]): StatusChange[] {
  const changes: StatusChange[] = [];
  for (const s of running) {
    const prev = prevStatus.get(s.key);
    if (prev && prev !== s.status) changes.push({ key: s.key, name: s.name, agent: s.agent, from: prev, to: s.status, tty: s.tty });
    prevStatus.set(s.key, s.status);
  }
  return changes;
}

// 要約トリガー: busy → idle/waiting の遷移時 + 要約未作成の実行中セッション
function fireSummaries(changes: StatusChange[], running: Session[]) {
  if (config.summarize === false) return;
  for (const c of changes)
    if (c.from === "busy" && (c.to === "waiting" || c.to === "idle")) requestSummary(c.key);
  for (const s of running)
    if (!summariesMap.has(baseKey(s.key))) requestSummary(s.key, false, true);
}

// macOS 通知(busy→waiting/idle)
function fireMacNotify(changes: StatusChange[]) {
  if (!config.macNotify) return;
  for (const c of changes) {
    if (c.from !== "busy" || (c.to !== "waiting" && c.to !== "idle")) continue;
    const label = c.to === "waiting" ? "入力待ち" : "完了";
    macNotify(`${c.name} — ${label}`, `${c.agent} / クリックでターミナルへ`, c.tty).catch(() => {});
  }
}

async function poll() {
  try {
    await updateRolloutCache();
    loadCodexNames();
    // claudeRunning() はキャッシュ読み出しのみ(取得は refreshClaudeRunning が別タイマーで行う)
    const cr = claudeRunning();
    const xr = await codexRunning();
    const running = [...cr, ...xr, ...remoteCacheList()];
    assignStableKeys(running);
    const runningSids = new Set(running.map(s => s.sid));
    const recents = [...claudeRecent(runningSids), ...codexRecent(runningSids)]
      .filter(s => !runningSids.has(s.sid));
    fixZombieBusy(running);
    const screens = await captureScreens(running.map(s => s.tty));
    applyPrompts(running, screens);
    // git 情報(キャッシュ付き)
    await Promise.all(running.map(async s => {
      const g = await gitInfo(s.cwd);
      if (g) s.git = g;
    }));
    const order: Record<string, number> = { waiting: 0, busy: 1, idle: 2, resumable: 3 };
    const sessions = [...running, ...recents]
      .sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9) || a.ageS - b.ageS)
      // リモートは tty を持たず pollRemotes が s.screen を埋めているので温存する
      .map(s => ({
        ...s,
        screen: (s as RemoteSession).screen ?? screens.get(s.tty),
        summary: summariesMap.get(baseKey(s.key)),
        stalled: s.tty && isTtyStalled(s.tty) ? true : undefined,
        tmuxTarget: s.tty ? tmuxTargetByTty.get(s.tty) : undefined,
      }));
    // キーはカードの同一性そのもの。重複すると選択が複数行に出るなど表示が壊れるため、
    // 最後に必ず一意化する(リモートは pid を持たず assignStableKeys の対象外)
    {
      const seen = new Set<string>();
      for (const s of sessions) {
        if (!seen.has(s.key)) { seen.add(s.key); continue; }
        let i = 2, k = `${s.key}#${i}`;
        while (seen.has(k)) k = `${s.key}#${++i}`;
        s.key = k;
        seen.add(k);
      }
    }
    lastSnapshot = { sessions, at: Date.now() };
    const changes = detectChanges(running);
    fireSummaries(changes, running);
    fireMacNotify(changes);
    const msg = JSON.stringify({ type: "snapshot", ...lastSnapshot, changes, assetVersion: assetVersion() });
    for (const ws of wsClients) { try { ws.send(msg); } catch {} }
  } catch (e) {
    console.error("poll error:", e);
  } finally {
    setTimeout(poll, POLL_MS);
  }
}

// ---------------------------------------------------------------- HTTP サーバー
const INDEX_HTML = join(import.meta.dir, "public", "index.html");

// ---- アクセス制御 ----
// 既定は 127.0.0.1 バインドで到達者＝本人なので認証不要。tailscale serve 等で
// LAN/tailnet に出す場合のみ AGD_TOKEN を設定する。到達できる者はセッションへ
// コマンドを送れるため、公開時は多重防御としてトークンを要求する。
const TOKEN = (process.env.AGD_TOKEN || "").trim();
const BIND = process.env.AGD_BIND || "127.0.0.1";
// 送信系を止める。スマホからは監視だけしたい場合に使う
const READONLY = /^(1|true|yes)$/i.test(process.env.AGD_READONLY || "");
const COOKIE = "agd_token";
// 書き込み系(セッションを操作する)API。READONLY ではここを拒否する
const MUTATING = new Set([
  "/api/send", "/api/key", "/api/close", "/api/new", "/api/resume",
  "/api/remote-attach", "/api/remotes", "/api/config", "/api/summarize",
]);

function cookieOf(req: Request, name: string): string {
  const raw = req.headers.get("cookie") ?? "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return "";
}
// 長さを揃えてから比較し、タイミング差で桁が漏れないようにする
function tokenEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
// 事故防止: localhost 以外に出すのにトークンが無い構成は起動させない。
// この状態は「到達できる誰でもターミナルを操作できる」ことを意味する。
if (BIND !== "127.0.0.1" && BIND !== "localhost" && !TOKEN) {
  console.error("AGD_BIND で外部に公開する場合は AGD_TOKEN が必須です(未設定のため起動を中止)");
  console.error(`例: AGD_TOKEN=$(openssl rand -hex 24) AGD_BIND=${BIND} agd web`);
  process.exit(1);
}

function authed(req: Request, url: URL, ip?: string): boolean {
  if (!TOKEN) return true;
  // ループバック免除は実装しない。tailscale serve のようなプロキシ経由の
  // 外部アクセスも 127.0.0.1 から来るため、免除するとトークンが無意味になる
  // (実測で確認済み)。ローカルの agd.app には URL にトークンを埋めて渡す。
  const t = url.searchParams.get("token") || cookieOf(req, COOKIE)
    || (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  return !!t && tokenEq(t, TOKEN);
}

try {
  Bun.serve({
  port: PORT,
  // 既定は 127.0.0.1。セッションへコマンドを送れるため、外に出すときは
  // AGD_BIND と AGD_TOKEN を必ず併用する(下の起動時チェックで警告する)
  hostname: BIND,
  idleTimeout: 60,
  async fetch(req, server) {
    const url = new URL(req.url);
    // アイコンは Cookie 無しで取りに来る(iOS のホーム画面追加など)。
    // 機密を含まないので認証前に返す
    const PUBLIC_ASSETS = new Set([
      "/favicon.ico", "/favicon-256.png",
      "/apple-touch-icon.png", "/apple-touch-icon-precomposed.png",
      "/manifest.webmanifest",
    ]);
    if (PUBLIC_ASSETS.has(url.pathname)) {
      const name = url.pathname === "/apple-touch-icon-precomposed.png"
        ? "apple-touch-icon.png" : url.pathname.slice(1);
      const type = name.endsWith(".ico") ? "image/x-icon"
        : name.endsWith(".webmanifest") ? "application/manifest+json" : "image/png";
      return new Response(Bun.file(join(import.meta.dir, "public", name)), {
        headers: { "Content-Type": type, "Cache-Control": "no-cache" },
      });
    }
    if (!authed(req, url, server.requestIP(req)?.address)) {
      // ?token=... で来たら Cookie に載せ替えて以後の往復を楽にする
      return new Response("unauthorized", {
        status: 401,
        headers: { "Content-Type": "text/plain;charset=utf-8" },
      });
    }
    // 正しいトークンが URL で来たら Cookie に保存(以後はパラメータ不要)
    const setCookie = TOKEN && url.searchParams.get("token") === TOKEN
      ? { "Set-Cookie": `${COOKIE}=${encodeURIComponent(TOKEN)}; Path=/; Max-Age=31536000; SameSite=Lax` }
      : undefined;
    if (READONLY && req.method === "POST" && MUTATING.has(url.pathname))
      return Response.json({ error: "read-only mode" }, { status: 403 });
    if (url.pathname === "/ws") {
      if (server.upgrade(req)) return undefined as any;
      return new Response("upgrade failed", { status: 400 });
    }
    const noCache = { "Cache-Control": "no-store", ...(setCookie ?? {}) };
    if (url.pathname === "/" || url.pathname === "/index.html")
      return new Response(Bun.file(INDEX_HTML), { headers: noCache });
    // モバイルビュー(別ビュー。共通ロジックは core.js を共有する)
    if (url.pathname === "/m" || url.pathname === "/m.html")
      return new Response(Bun.file(join(import.meta.dir, "public", "m.html")), {
        headers: { ...noCache, "Content-Type": "text/html;charset=utf-8" },
      });
    // フロントの JS はいずれも no-store(更新が即反映されないと調査が難しくなる)。
    // パスは許可リストで固定し、任意のファイルを読ませない。
    {
      const JS = new Set(["/app.js", "/i18n.js", "/core.js", "/mobile.js"]);
      if (JS.has(url.pathname))
        return new Response(Bun.file(join(import.meta.dir, "public", url.pathname.slice(1))), { headers: noCache });
    }
    if (url.pathname === "/favicon.ico")
      return new Response(Bun.file(join(import.meta.dir, "public", "favicon.ico")));
    if (url.pathname === "/favicon-256.png")
      return new Response(Bun.file(join(import.meta.dir, "public", "favicon-256.png")));
    // ホーム画面に追加したときのアイコン。iOS は角を自前で丸めるため、
    // 角丸を焼き込んでいない正方形の画像を渡す
    if (url.pathname === "/apple-touch-icon.png" || url.pathname === "/apple-touch-icon-precomposed.png")
      return new Response(Bun.file(join(import.meta.dir, "public", "apple-touch-icon.png")));
    if (url.pathname === "/api/sessions")
      return Response.json(lastSnapshot);
    if (url.pathname === "/api/projects") {
      const cwds = [...new Set(lastSnapshot.sessions.map(s => s.cwd).filter(Boolean))].sort();
      return Response.json({ projects: cwds });
    }
    if (url.pathname === "/api/search") {
      const q = url.searchParams.get("q") ?? "";
      if (q.length < 2) return Response.json({ hits: [] });
      if (workerReady) {
        const raw = await workerSearch(q);
        if (raw) return Response.json({ hits: enrichHits(raw) });
      }
      // Worker 準備中・タイムアウト時は従来の grep 検索でしのぐ
      return Response.json({ hits: await searchLogs(q), indexing: workerReady ? undefined : workerProgress });
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
        if (typeof body.summarize === "boolean") config.summarize = body.summarize;
        await saveConfig();
      }
      // AGD_PATH_STRIP: 表示上「…」に短縮する共通パスプレフィックス(例: ~/projects)
      const pathStrip = (process.env.AGD_PATH_STRIP ?? "").replace(/^~(?=\/|$)/, HOME);
      // ssh のポートフォワード越しに見ていると location.hostname が localhost になり、
      // 手元に渡す attach コマンドが「自分自身に ssh する」壊れたものになる。
      // このホストの名前を渡して、フロント側でそれを ssh 先として使えるようにする
      // tmuxBin: attach コマンドに埋める tmux の絶対パス。ssh の非対話実行は
      // /etc/zprofile を読まず PATH が /usr/bin:/bin:/usr/sbin:/sbin だけになるため、
      // 素の "tmux" では command not found になる(実測)
      return Response.json({
        ...config, pathStrip, readOnly: READONLY,
        sshHost: await sshHostName(), tmuxBin: tmuxBin(),
      });
    }
    if (req.method === "POST" && url.pathname === "/api/key") {
      const { tty, key, keys, cardKey } = await req.json();
      const rm = remoteOf(String(cardKey ?? ""));
      if (rm) {
        const list = Array.isArray(keys) ? keys : [key];
        let out = "";
        for (const k of list) out = await remoteKey(rm.h, rm.paneId, String(k).slice(0, 10));
        return Response.json({ result: out });
      }
      if (!tty || (!key && !Array.isArray(keys))) return Response.json({ error: "tty and key(s) required" }, { status: 400 });
      const r = Array.isArray(keys)
        ? await sendKeysToTty(tty, keys.map((k: any) => String(k).slice(0, 10)))
        : await sendKeyToTty(tty, String(key).slice(0, 10));
      return Response.json({ result: r });
    }
    if (req.method === "POST" && url.pathname === "/api/new") {
      const { agent, cwd, create, cardKey } = await req.json();
      const abs = String(cwd ?? "").replace(/^~(?=\/|$)/, HOME);
      if (!abs.startsWith("/")) return Response.json({ error: "invalid cwd" }, { status: 400 });
      // リモートセッションの複製は、そのホスト側で起こす。
      // ここでローカルの存在確認にかけると /mnt/c/... のような
      // リモートにしか無いパスが必ず invalid cwd になる
      const rmNew = remoteOf(String(cardKey ?? ""));
      if (rmNew) {
        const rr = await remoteNew(rmNew.h, agent === "codex" ? "codex" : "claude", abs);
        if (rr.startsWith("error")) return Response.json({ error: rr.replace(/^error:\s*/, "") }, { status: 400 });
        return Response.json({ result: rr });
      }
      if (!existsSync(abs)) {
        if (!create) return Response.json({ error: "invalid cwd" }, { status: 400 });
        try { mkdirSync(abs, { recursive: true }); } catch (e: any) {
          return Response.json({ error: "mkdir failed: " + (e?.message ?? e) }, { status: 400 });
        }
      }
      const r = await openNew(agent === "codex" ? "codex" : "claude", abs);
      // 起動できなかったときは error として返す。UI 側は result しか見ないと
      // 失敗を成功として扱ってしまう
      if (r.startsWith("error")) return Response.json({ error: r.replace(/^error:\s*/, "") }, { status: 500 });
      return Response.json({ result: r });
    }
    if (url.pathname === "/api/transcript") {
      const agent = url.searchParams.get("agent") ?? "";
      const sid = url.searchParams.get("sid") ?? "";
      const limit = Number(url.searchParams.get("limit") ?? 300);
      const sub = url.searchParams.get("sub");
      // リモートセッションはログもリモート側にしかないので取り寄せる
      const rh = remoteHostBySid(sid);
      let path = rh
        ? await syncRemoteTranscript(rh, agent === "claude" ? "claude" : "codex", sid)
        : (agent === "claude" ? findClaudeTranscript(sid) : rolloutById(sid)?.path);
      if (!rh && sub && agent === "claude" && /^[A-Za-z0-9_-]+$/.test(sub)) {
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
      if (!q.startsWith("/")) return Response.json({ dirs: [], exists: false });
      let exists = false;
      try { exists = statSync(q).isDirectory(); } catch {}
      // browse=1: q そのものの中身を名前順に返す(モバイルのディレクトリツリー用)。
      // 既定は入力補完で、q の「親」を前方一致で絞る。件数上限も用途が違う
      // (補完は候補を絞りたい / ツリーは辿りたいので多めに返す)
      const browse = url.searchParams.get("browse") === "1" && exists;
      const cut = q.lastIndexOf("/");
      const base = browse ? q : (cut === 0 ? "/" : q.slice(0, cut));
      const prefix = browse ? "" : q.slice(cut + 1).toLowerCase();
      const limit = browse ? 300 : 15;
      const dirs: string[] = [];
      try {
        const names = readdirSync(base);
        if (browse) names.sort((a, b) => a.localeCompare(b));
        for (const name of names) {
          if (dirs.length >= limit) break;
          if (name.startsWith(".") && !prefix.startsWith(".")) continue;
          if (!name.toLowerCase().startsWith(prefix)) continue;
          const full = join(base, name);
          try { if (statSync(full).isDirectory()) dirs.push(full); } catch {}
        }
      } catch {}
      return Response.json({ dirs, exists });
    }
    if (req.method === "POST" && url.pathname === "/api/send") {
      const { tty, text, cardKey } = await req.json();
      if (!text) return Response.json({ error: "text required" }, { status: 400 });
      const rm = remoteOf(String(cardKey ?? ""));
      if (rm) return Response.json({ result: await remoteSend(rm.h, rm.paneId, String(text)) });
      if (!tty) return Response.json({ error: "tty and text required" }, { status: 400 });
      const r = await sendToTty(tty, text);
      return Response.json({ result: r });
    }
    if (url.pathname === "/api/remotes") {
      if (req.method === "GET") {
        const now = Date.now();
        return Response.json({
          remotes: remoteHosts().map(h => {
            const c = remoteCache.get(h.host);
            return {
              ...h,
              sessions: c?.list.length ?? 0,
              connected: !!c && now - c.at < REMOTE_STALE_MS,
              ageS: c ? Math.round((now - c.at) / 1000) : null,
            };
          }),
        });
      }
      if (req.method === "POST") {
        const { host, label, path, remove } = await req.json();
        if (!host) return Response.json({ error: "host required" }, { status: 400 });
        const list = remoteHosts().filter(h => h.host !== host);
        if (!remove) list.push({ host: String(host), label, path });
        else remoteCache.delete(String(host));
        config.remotes = list;
        await saveConfig();
        if (!remove) pollRemotes();
        return Response.json({ ok: true, remotes: config.remotes });
      }
    }
    if (req.method === "POST" && url.pathname === "/api/summarize") {
      const { key } = await req.json();
      if (!key) return Response.json({ error: "key required" }, { status: 400 });
      requestSummary(String(key), true);
      return Response.json({ result: "queued" });
    }
    if (req.method === "POST" && url.pathname === "/api/close") {
      const { tty, cardKey } = await req.json();
      const rm = remoteOf(String(cardKey ?? ""));
      if (rm) return Response.json({ result: await remoteClose(rm.h, rm.paneId) });
      // tty が取れないセッション(端末を閉じた後など)は pid に SIGTERM を送る。
      // これが無いと一覧から消せないカードが残り続ける
      if (!tty) {
        const s = lastSnapshot.sessions.find(x => x.key === cardKey);
        if (s?.pid) {
          try { process.kill(s.pid, "SIGTERM"); return Response.json({ result: "ok(signal)" }); }
          catch (e: any) {
            // 既に死んでいるなら目的は達成されている
            if (e?.code === "ESRCH") return Response.json({ result: "ok(gone)" });
            return Response.json({ result: "error: " + (e?.message ?? e) });
          }
        }
        return Response.json({ error: "tty required" }, { status: 400 });
      }
      const r = await closeTty(tty);
      return Response.json({ result: r });
    }
    if (req.method === "POST" && url.pathname === "/api/focus") {
      const { tty, cardKey } = await req.json();
      // リモートは手元で ssh + tmux attach しているターミナルがあればそこへ飛ぶ
      const rm = remoteOf(String(cardKey ?? ""));
      if (rm) {
        const s = remoteCacheList().find(x => x.key === cardKey);
        const localTty = s?.remote ? await localTtyForRemote(s.remote.host, s.remote.target) : null;
        if (!localTty)
          // 手元に attach が無い。UI 側でターミナルを開くか尋ねられるよう情報を返す
          return Response.json({
            result: "error: no local ssh session",
            needAttach: { host: s?.remote?.host ?? "", tmuxSession: (s?.remote?.target ?? "").split(":")[0] },
          });
        // 目的のペインを手元の tmux 表示にも切り替えてからフォーカスする
        if (s?.remote) await remoteSelectPane(rm.h, s.remote.paneId);
        return Response.json({ result: await focusTty(localTty) });
      }
      const r = await focusTty(tty);
      // 前面に出せなかった理由を返す。tmux の detached セッション(agd が
      // ヘッドレス時に起こしたもの)には対応する iTerm タブが無いため、
      // 「別マシンから見ている」と区別が付かず、UI が誤った案内を出していた
      const localTmux = r.startsWith("ok") ? "" : (tmuxTargetByTty.get(String(tty ?? "")) ?? "");
      return Response.json({ result: r, localTmux });
    }
    if (req.method === "POST" && url.pathname === "/api/remote-attach") {
      const { host, tmuxSession } = await req.json();
      const h = remoteHostOf(String(host ?? ""));
      if (!h) return Response.json({ error: "unknown host" }, { status: 400 });
      if (!/^[A-Za-z0-9_.-]+$/.test(String(tmuxSession ?? "")))
        return Response.json({ error: "invalid tmux session" }, { status: 400 });
      return Response.json({ result: await openRemoteAttach(h, String(tmuxSession)) });
    }
    if (req.method === "POST" && url.pathname === "/api/resume") {
      const { agent, sid, cwd, fork, cardKey } = await req.json();
      // 実行中セッションの複製はクライアント指定に関わらず必ず fork する
      // (素の resume だと同一トランスクリプトに追記されログが交錯するため)
      const isRunning = lastSnapshot.sessions.some(s => s.running && s.sid === sid)
        || remoteCacheList().some(s => s.running && s.sid === sid);
      // /api/new と同じ理由でリモートは起動先のホストへ委譲する。
      // cwd は母艦に存在せず、仮に存在しても母艦で起動してしまうため
      const rmRes = remoteOf(String(cardKey ?? ""));
      if (rmRes) {
        const rr = await remoteResume(rmRes.h, agent === "codex" ? "codex" : "claude",
                                      String(sid ?? ""), String(cwd ?? ""), !!fork || isRunning);
        if (rr.startsWith("error")) return Response.json({ error: rr.replace(/^error:\s*/, "") }, { status: 400 });
        return Response.json({ result: rr });
      }
      const r = await openResume(agent, sid, cwd, !!fork || isRunning);
      if (r.startsWith("error")) return Response.json({ error: r.replace(/^error:\s*/, "") }, { status: 500 });
      return Response.json({ result: r });
    }
    return new Response("not found", { status: 404 });
  },
  websocket: {
    open(ws) {
      wsClients.add(ws);
      ws.send(JSON.stringify({ type: "snapshot", ...lastSnapshot, changes: [], assetVersion: assetVersion() }));
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

// claude agents は遅いことがあるので poll() とは別タイマーで回す。
// 実行中は refreshClaudeRunning 内のガードで次回起動を抑えるため、
// 間隔より取得時間が長くても多重実行にはならない。
refreshClaudeRunning();
setInterval(refreshClaudeRunning, 5000);

poll();

// リモートは ssh の往復が読めないので独立したタイマーで回す
if (remoteHosts().length) {
  for (const h of remoteHosts())
    remotePing(h).then(ok => console.log(`remote ${h.host}: ${ok ? "connected" : "unreachable (ssh か tmux が無い)"}`));
  pollRemotes();
  setInterval(pollRemotes, REMOTE_POLL_MS);
}
