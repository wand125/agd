// リモートホスト(ssh 越し)の tmux セッションを取り込む。
//
// 前提: リモート側で claude/codex が tmux ペインの中で動いていること。
// tmux があれば capture-pane / send-keys / kill-pane がそのまま使えるので、
// ローカルの tmux 経路と同じ手段でひと通りの操作ができる。
//
// 接続コストを抑えるため ssh の ControlMaster を agd 専用の ControlPath で使う。
// ユーザーの ~/.ssh/config は書き換えない(-o で都度指定する)。
import { mkdirSync } from "fs";
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
};

export async function remotePanes(h: RemoteHost): Promise<RemotePane[]> {
  const fmt = "#{pane_id}\t#{session_name}:#{window_index}.#{pane_index}\t#{pane_tty}\t#{pane_current_command}\t#{pane_current_path}";
  const out = await shRemote(h, `tmux list-panes -a -F '${fmt}' 2>/dev/null`);
  return out.trim().split("\n").filter(Boolean).flatMap(l => {
    const [paneId, target, tty, cmd, cwd] = l.split("\t");
    if (!paneId || !target) return [];
    return [{ host: h.host, paneId, target, tty: tty ?? "", cmd: cmd ?? "", cwd: cwd ?? "" }];
  });
}

// ---- セッション検出 ----
// claude agents --json でプロセスと状態を取り、tmux ペインと cwd で突き合わせる。
type ClaudeAgent = { pid: number; cwd: string; sessionId: string; name: string; status: string; kind?: string };

export async function remoteSessions(h: RemoteHost): Promise<Session[]> {
  const [panes, agentsRaw] = await Promise.all([
    remotePanes(h),
    shRemote(h, `claude agents --json 2>/dev/null`),
  ]);
  if (!panes.length) return [];

  let agents: ClaudeAgent[] = [];
  try {
    const j = JSON.parse(agentsRaw);
    if (Array.isArray(j)) agents = j.filter(a => a?.sessionId && a?.kind !== "subagent");
  } catch {}

  const label = h.label || h.host;
  const out: Session[] = [];
  const usedPane = new Set<string>();

  // claude は sessionId が取れるので、同じ cwd のペインに割り当てる。
  // 同一 cwd に複数ペインがある場合は先着順(agents 側の順序を尊重)。
  for (const a of agents) {
    const pane = panes.find(p => !usedPane.has(p.paneId) && p.cwd === a.cwd && /^(claude|node)$/.test(p.cmd));
    if (!pane) continue;
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
    out.push({
      key: `${p.cmd === "codex" ? "codex" : "claude"}:${h.host}:${p.paneId}`,
      agent: p.cmd === "codex" ? "codex" : "claude",
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
export async function remoteCapture(h: RemoteHost, paneId: string, lines = 60): Promise<string> {
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

export async function remoteClose(h: RemoteHost, paneId: string): Promise<string> {
  await shRemote(h, `tmux kill-pane -t ${q(paneId)}`);
  return "ok(remote)";
}

// 接続確認。起動時に一度だけ呼んでログに出す
export async function remotePing(h: RemoteHost): Promise<boolean> {
  const out = await shRemote(h, `tmux -V 2>/dev/null || echo NO_TMUX`, 6000);
  return out.trim().startsWith("tmux ");
}
