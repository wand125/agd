// リモートホスト(ssh 越し)の tmux セッションを取り込む。
//
// 前提: リモート側で claude/codex が tmux ペインの中で動いていること。
// tmux があれば capture-pane / send-keys / kill-pane がそのまま使えるので、
// ローカルの tmux 経路と同じ手段でひと通りの操作ができる。
//
// 接続コストを抑えるため ssh の ControlMaster を agd 専用の ControlPath で使う。
// ユーザーの ~/.ssh/config は書き換えない(-o で都度指定する)。
import { mkdirSync, statSync, appendFileSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { Session } from "./server";

const HOME = homedir();
const SOCK_DIR = join(HOME, ".cache", "agd", "ssh");

export type RemoteHost = {
  host: string;          // ssh の宛先(~/.ssh/config の Host 名でよい)
  label?: string;        // UI 表示名。省略時は host
  path?: string;         // リモートの PATH に前置する値(例: "$HOME/.local/bin")
};

// ssh は tmux/claude を PATH から探せないことがある(非対話シェルは
// .bashrc を読まないため)。呼び出し側で明示的に PATH を足す。
function wrap(h: RemoteHost, cmd: string): string {
  const p = h.path ?? "$HOME/.local/bin";
  return `export PATH=${p}:$PATH; ${cmd}`;
}

function sshArgs(h: RemoteHost): string[] {
  try { mkdirSync(SOCK_DIR, { recursive: true }); } catch {}
  return [
    "ssh",
    "-o", "BatchMode=yes",              // パスフレーズ待ちでハングさせない
    "-o", "ConnectTimeout=5",
    "-o", "ControlMaster=auto",
    "-o", `ControlPath=${join(SOCK_DIR, "%r@%h:%p")}`,
    "-o", "ControlPersist=300",         // 5分は接続を使い回す
    h.host,
  ];
}

async function shRemote(h: RemoteHost, cmd: string, timeoutMs = 8000): Promise<string> {
  try {
    const p = Bun.spawn([...sshArgs(h), wrap(h, cmd)], { stderr: "ignore" });
    const timer = setTimeout(() => { try { p.kill(); } catch {} }, timeoutMs);
    const out = await new Response(p.stdout).text();
    await p.exited;
    clearTimeout(timer);
    return out;
  } catch {
    return "";
  }
}

// ---- ペイン一覧 ----
export type RemotePane = {
  host: string;
  paneId: string;        // %3 など
  target: string;        // consult:0.0
  tty: string;           // /dev/pts/3
  cmd: string;           // claude / codex / bash
  cwd: string;
  pid: number;           // ペインのシェルの pid(claude はこの子孫)
};

export async function remotePanes(h: RemoteHost): Promise<RemotePane[]> {
  // 区切りは "|"。tmux はロケール未設定の環境だとタブを "_" に置換してしまい
  // 列がずれる(ローカル側で実害が出たため合わせる)。cwd に "|" は通常現れない
  const fmt = "#{pane_id}|#{session_name}:#{window_index}.#{pane_index}|#{pane_tty}|#{pane_current_command}|#{pane_current_path}|#{pane_pid}";
  const out = await shRemote(h, `tmux list-panes -a -F '${fmt}' 2>/dev/null`);
  return out.trim().split("\n").filter(Boolean).flatMap(l => {
    const [paneId, target, tty, cmd, cwd, pid] = l.split("|");
    if (!paneId || !target) return [];
    return [{ host: h.host, paneId, target, tty: tty ?? "", cmd: cmd ?? "", cwd: cwd ?? "", pid: Number(pid) || 0 }];
  });
}

// pid → ppid の対応表。claude の pid からペインの pid まで遡って紐付ける。
// 同一 cwd に複数セッションがある場合、cwd 突合では左右が入れ違うため必須。
async function remotePpidMap(h: RemoteHost): Promise<Map<number, number>> {
  const out = await shRemote(h, `ps -eo pid=,ppid= 2>/dev/null`);
  const m = new Map<number, number>();
  for (const l of out.split("\n")) {
    const mm = l.trim().match(/^(\d+)\s+(\d+)$/);
    if (mm) m.set(Number(mm[1]), Number(mm[2]));
  }
  return m;
}

// ---- セッション検出 ----
// claude agents --json でプロセスと状態を取り、tmux ペインと cwd で突き合わせる。
type ClaudeAgent = { pid: number; cwd: string; sessionId: string; name: string; status: string; kind?: string };

export async function remoteSessions(h: RemoteHost): Promise<Session[]> {
  const [panes, agentsRaw, ppid] = await Promise.all([
    remotePanes(h),
    shRemote(h, `claude agents --json 2>/dev/null`),
    remotePpidMap(h),
  ]);
  if (!panes.length) return [];

  // claude の pid から祖先を辿り、どのペインに属するかを決める
  const paneByPid = new Map(panes.map(p => [p.pid, p]));
  const paneOfPid = (pid: number): RemotePane | undefined => {
    let cur = pid;
    for (let i = 0; i < 12 && cur > 1; i++) {
      const p = paneByPid.get(cur);
      if (p) return p;
      const next = ppid.get(cur);
      if (!next || next === cur) break;
      cur = next;
    }
    return undefined;
  };

  let agents: ClaudeAgent[] = [];
  try {
    const j = JSON.parse(agentsRaw);
    if (Array.isArray(j)) agents = j.filter(a => a?.sessionId && a?.kind !== "subagent");
  } catch {}

  const label = h.label || h.host;
  const out: Session[] = [];
  const usedPane = new Set<string>();

  // claude の pid からペインを特定する。cwd 突合だと同一プロジェクトで
  // 複数セッションを開いた際に画面とログが入れ違うため、pid の親子関係を使う。
  for (const a of agents) {
    const pane = paneOfPid(a.pid)
      // pid で辿れない場合のみ cwd で代替(ps が使えない環境向け)
      ?? panes.find(p => !usedPane.has(p.paneId) && p.cwd === a.cwd && /^(claude|node)$/.test(p.cmd));
    if (!pane || usedPane.has(pane.paneId)) continue;
    usedPane.add(pane.paneId);
    out.push({
      key: `claude:${a.sessionId}@${h.host}`,
      agent: "claude",
      sid: a.sessionId,
      name: `${label}/${a.name || a.sessionId.slice(0, 8)}`,
      cwd: a.cwd,
      status: a.status === "busy" ? "busy" : a.status === "waiting" ? "waiting" : "idle",
      running: true,
      tty: "",                          // ローカルの tty ではないので空。操作は remote 経由
      ageS: 0,
      remote: { host: h.host, paneId: pane.paneId, target: pane.target },
    } as Session);
  }

  // agents に出ないもの(codex や、agents が使えない環境)はペインから拾う
  for (const p of panes) {
    if (usedPane.has(p.paneId)) continue;
    if (!/^(claude|codex|node)$/.test(p.cmd)) continue;
    // cmd が node のときは実体が分からない。tmux のセッション名(codex:0.0 など)
    // から推測する。誤って claude 扱いにすると、同名のカードが並んだときに
    // どちらか判別できなくなる
    const isCodex = p.cmd === "codex" || /(^|\W)codex/i.test(p.target);
    out.push({
      key: `${isCodex ? "codex" : "claude"}:${h.host}:${p.paneId}`,
      agent: isCodex ? "codex" : "claude",
      sid: "",
      name: `${label}/${p.target}`,
      cwd: p.cwd,
      status: "idle",
      running: true,
      tty: "",
      ageS: 0,
      remote: { host: h.host, paneId: p.paneId, target: p.target },
    } as Session);
  }
  return out;
}

// ---- 画面キャプチャ ----
export async function remoteCapture(h: RemoteHost, paneId: string,
    lines = Number(process.env.AGD_SCROLLBACK || 200)): Promise<string> {
  // -e で色を保持。-S -N で少し遡り、-J で折り返しを結合しない(桁ズレ防止)
  return shRemote(h, `tmux capture-pane -p -e -t '${paneId}' -S -${lines} 2>/dev/null`);
}

// ---- 操作 ----
// send-keys の引数はリモートのシェルを経由するのでシングルクォートで包む。
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export async function remoteSend(h: RemoteHost, paneId: string, text: string): Promise<string> {
  // 本文と Enter を分けて送る。まとめて送るとペースト扱いされ確定しないことがある
  await shRemote(h, `tmux send-keys -t ${q(paneId)} -l ${q(text)}`);
  await new Promise(r => setTimeout(r, 150));
  await shRemote(h, `tmux send-keys -t ${q(paneId)} Enter`);
  return "ok(remote)";
}

export async function remoteKey(h: RemoteHost, paneId: string, key: string): Promise<string> {
  const named: Record<string, string> = {
    ShiftTab: "BTab", Escape: "Escape", Enter: "Enter", Tab: "Tab",
    Up: "Up", Down: "Down", Left: "Left", Right: "Right",
  };
  const k = named[key];
  if (k) await shRemote(h, `tmux send-keys -t ${q(paneId)} ${k}`);
  else await shRemote(h, `tmux send-keys -t ${q(paneId)} -l ${q(key)}`);
  return "ok(remote)";
}

// 手元の tmux 表示を目的のペインへ切り替える(ジャンプ時に使う)。
// attach 中のクライアントに、そのペインのウィンドウを選ばせる。
export async function remoteSelectPane(h: RemoteHost, paneId: string): Promise<void> {
  await shRemote(h, `tmux select-window -t ${q(paneId)} \\; select-pane -t ${q(paneId)} 2>/dev/null`);
}

export async function remoteClose(h: RemoteHost, paneId: string): Promise<string> {
  await shRemote(h, `tmux kill-pane -t ${q(paneId)}`);
  return "ok(remote)";
}

// ---- トランスクリプト ----
// リモートのログはリモート側にしかないので、ローカルへ取り寄せてキャッシュする。
// 毎回全部を転送しないよう、サイズが増えた分だけ追記する(tail -c +N)。
const TRANS_DIR = join(HOME, ".cache", "agd", "remote-transcripts");
const fetched = new Map<string, number>();   // ローカルパス → 取り込み済みバイト数

export function remoteTranscriptPath(host: string, agent: string, sid: string): string {
  return join(TRANS_DIR, `${host}__${agent}__${sid}.jsonl`);
}

// リモート上のトランスクリプトのパスを解決する(claude のみ。codex は rollout)
async function remoteTranscriptRemotePath(h: RemoteHost, agent: string, sid: string): Promise<string> {
  if (agent === "claude") {
    const out = await shRemote(h, `ls -1 ~/.claude/projects/*/${sid}.jsonl 2>/dev/null | head -1`);
    return out.trim();
  }
  const out = await shRemote(h, `ls -1 ~/.codex/sessions/*/*/*/rollout-*${sid}.jsonl 2>/dev/null | head -1`);
  return out.trim();
}

// 差分だけ取り寄せてローカルのパスを返す。取得できなければ null。
export async function syncRemoteTranscript(h: RemoteHost, agent: string, sid: string): Promise<string | null> {
  if (!sid) return null;
  try { mkdirSync(TRANS_DIR, { recursive: true }); } catch {}
  const local = remoteTranscriptPath(h.host, agent, sid);
  const remotePath = await remoteTranscriptRemotePath(h, agent, sid);
  if (!remotePath) return null;

  let have = fetched.get(local);
  if (have === undefined) {
    try { have = statSync(local).size; } catch { have = 0; }
  }
  // リモートのサイズを見て、増えていなければ何もしない
  const sizeOut = await shRemote(h, `stat -c %s ${JSON.stringify(remotePath)} 2>/dev/null || wc -c < ${JSON.stringify(remotePath)}`);
  const size = Number(sizeOut.trim()) || 0;
  if (size && have && size === have) return local;
  if (size && have && size < have) { have = 0; }   // 縮んだら取り直し

  // tail -c +N は 1 始まりのバイト位置
  const cmd = have
    ? `tail -c +${have + 1} ${JSON.stringify(remotePath)}`
    : `cat ${JSON.stringify(remotePath)}`;
  const chunk = await shRemote(h, cmd, 20_000);
  if (!chunk && !have) return null;
  try {
    if (have) appendFileSync(local, chunk);
    else writeFileSync(local, chunk);
    fetched.set(local, statSync(local).size);
  } catch { return null; }
  return local;
}

// 接続確認。起動時に一度だけ呼んでログに出す
export async function remotePing(h: RemoteHost): Promise<boolean> {
  const out = await shRemote(h, `tmux -V 2>/dev/null || echo NO_TMUX`, 6000);
  return out.trim().startsWith("tmux ");
}
