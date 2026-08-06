// 検索インデックス・全文検索・LLM要約を担う Worker スレッド。
// SQLite の同期操作や巨大トランスクリプトのパースをメインスレッド(HTTP/ポーリング)から
// 完全に隔離する。メインとはメッセージでやりとりする:
//   受信: {type:"reindex", targets} / {type:"search", id, q} /
//         {type:"summarize", key, path, agent, force}
//   送信: {type:"ready"} {type:"progress", done, total} {type:"searchResult", id, hits}
//         {type:"summariesAll", list} {type:"summary", key, text} {type:"log", msg}
import { Database } from "bun:sqlite";
import { statSync, rmSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { parseClaudeLines, parseCodexLines, readTranscript, type LogEntry } from "./transcript";
import { openSync, readSync, closeSync } from "fs";

declare const self: Worker;

const HOME = homedir();
const DB_PATH = join(HOME, ".cache", "agd", "search.db");
const INDEX_TEXT_CAP = 2000;
const MAX_DB_MB = Number(process.env.AGD_INDEX_MAX_MB || 300);

// ---- 置き場所の確保。~/.cache は外部ツールに丸ごと消されることがあるため毎回作る ----
try { mkdirSync(join(HOME, ".cache", "agd"), { recursive: true }); } catch {}

// ---- サイズガード: 上限超過なら作り直し(開く前にチェック) ----
try {
  const st = statSync(DB_PATH);
  if (st.size > MAX_DB_MB * 1048576) {
    for (const suf of ["", "-wal", "-shm"]) { try { rmSync(DB_PATH + suf); } catch {} }
    postMessage({ type: "log", msg: `search.db が ${Math.round(st.size / 1048576)}MB に達したため作り直します(上限 ${MAX_DB_MB}MB)` });
  }
} catch {}

const db = new Database(DB_PATH);
db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA synchronous = NORMAL");
db.run(`CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, offset INTEGER, agent TEXT, sid TEXT)`);
db.run(`CREATE TABLE IF NOT EXISTS entries (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT, idx INTEGER, role TEXT, ts TEXT, text TEXT)`);
db.run(`CREATE INDEX IF NOT EXISTS entries_path ON entries(path)`);
db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(text, content='entries', content_rowid='id', tokenize='trigram')`);
db.run(`CREATE TABLE IF NOT EXISTS summaries (key TEXT PRIMARY KEY, entry_count INTEGER, text TEXT, updated_at INTEGER)`);

type IndexTarget = { path: string; agent: "claude" | "codex"; sid: string; mtime: number };
let indexReady = false;

// FTS の 'rebuild' は全テーブル同期再構築で長時間ブロックするため使用禁止。
// ファイル単位で entries と FTS 行を対で削除する。
function dropFileFromIndex(path: string) {
  const rows = db.query(`SELECT id, text FROM entries WHERE path = ?`).all(path) as { id: number; text: string }[];
  if (!rows.length) return;
  const delF = db.prepare(`INSERT INTO entries_fts(entries_fts, rowid, text) VALUES('delete', ?, ?)`);
  const tx = db.transaction(() => {
    for (const r of rows) delF.run(r.id, r.text);
    db.run(`DELETE FROM entries WHERE path = ?`, [path]);
  });
  tx();
}

function indexFile(t: IndexTarget) {
  let st;
  try { st = statSync(t.path); } catch { return; }
  const row = db.query(`SELECT offset FROM files WHERE path = ?`).get(t.path) as { offset: number } | null;
  let offset = row?.offset ?? 0;
  if (st.size < offset) { dropFileFromIndex(t.path); offset = 0; }
  if (st.size <= offset) {
    db.run(`INSERT INTO files(path, offset, agent, sid) VALUES(?, ?, ?, ?)
            ON CONFLICT(path) DO UPDATE SET offset = excluded.offset`, [t.path, offset, t.agent, t.sid]);
    return;
  }
  try {
    const fd = openSync(t.path, "r");
    const len = st.size - offset;
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, offset);
    closeSync(fd);
    const chunk = buf.toString("utf8");
    const lastNl = chunk.lastIndexOf("\n");
    if (lastNl < 0) return;
    const complete = chunk.slice(0, lastNl);
    offset += Buffer.byteLength(complete, "utf8") + 1;
    const lines = complete.split("\n").filter(Boolean);
    const parsed = t.agent === "claude" ? parseClaudeLines(lines) : parseCodexLines(lines);
    const base = (db.query(`SELECT COALESCE(MAX(idx) + 1, 0) AS n FROM entries WHERE path = ?`).get(t.path) as any).n;
    const insE = db.prepare(`INSERT INTO entries(path, idx, role, ts, text) VALUES(?, ?, ?, ?, ?)`);
    const insF = db.prepare(`INSERT INTO entries_fts(rowid, text) VALUES(?, ?)`);
    const tx = db.transaction(() => {
      parsed.forEach((e, i) => {
        const text = e.text.slice(0, INDEX_TEXT_CAP);
        const r = insE.run(t.path, base + i, e.role, e.ts ?? "", text);
        insF.run(Number(r.lastInsertRowid), text);
      });
      db.run(`INSERT INTO files(path, offset, agent, sid) VALUES(?, ?, ?, ?)
              ON CONFLICT(path) DO UPDATE SET offset = excluded.offset`, [t.path, offset, t.agent, t.sid]);
    });
    tx();
  } catch {}
}

let reindexing = false;
async function reindex(targets: IndexTarget[]) {
  if (reindexing) return;
  reindexing = true;
  try {
    const keep = new Set(targets.map(t => t.path));
    const stale = db.query(`SELECT path FROM files`).all() as { path: string }[];
    for (const r of stale) if (!keep.has(r.path)) {
      dropFileFromIndex(r.path);
      db.run(`DELETE FROM files WHERE path = ?`, [r.path]);
      await Bun.sleep(1);  // 検索リクエストの割り込みを許す
    }
    let done = 0;
    for (const t of targets) {
      indexFile(t);
      done++;
      if (done % 10 === 0) postMessage({ type: "progress", done, total: targets.length });
      await Bun.sleep(1);
    }
    if (!indexReady) {
      indexReady = true;
      postMessage({ type: "ready", files: targets.length });
    }
  } catch (err: any) {
    // DB が外部から消される等の I/O エラーで Worker ごと落とさない。次回の
    // reindex で作り直しを試みる(ディレクトリ再作成込み)。
    postMessage({ type: "log", msg: `reindex 失敗: ${err?.message ?? err}` });
    try { mkdirSync(join(HOME, ".cache", "agd"), { recursive: true }); } catch {}
  } finally { reindexing = false; }
}

function searchIndex(q: string): { path: string; agent: string; sid: string; mtime: number; count: number; snippet: string }[] {
  const words = q.split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const useFts = words.every(w => [...w].length >= 3);
  let rows: { path: string; idx: number; text: string }[];
  if (useFts) {
    const match = words.map(w => `"${w.replaceAll(`"`, `""`)}"`).join(" AND ");
    rows = db.query(
      `SELECT e.path AS path, e.idx AS idx, e.text AS text
       FROM entries_fts f JOIN entries e ON e.id = f.rowid
       WHERE entries_fts MATCH ? ORDER BY e.id DESC LIMIT 800`).all(match) as any;
  } else {
    const conds = words.map(() => `text LIKE ? ESCAPE '\\'`).join(" AND ");
    const args = words.map(w => `%${w.replace(/[%_\\]/g, m => "\\" + m)}%`);
    rows = db.query(
      `SELECT path, idx, text FROM entries WHERE ${conds} ORDER BY id DESC LIMIT 800`).all(...args) as any;
  }
  const byPath = new Map<string, { count: number; first: { idx: number; text: string } }>();
  for (const r of rows) {
    const g = byPath.get(r.path);
    if (g) g.count++;
    else byPath.set(r.path, { count: 1, first: { idx: r.idx, text: r.text } });
  }
  const out: { path: string; agent: string; sid: string; mtime: number; count: number; snippet: string }[] = [];
  for (const [path, g] of byPath) {
    if (out.length >= 30) break;
    const meta = db.query(`SELECT agent, sid FROM files WHERE path = ?`).get(path) as { agent: string; sid: string } | null;
    if (!meta) continue;
    let mtime = 0;
    try { mtime = statSync(path).mtimeMs; } catch {}
    const lower = g.first.text.toLowerCase();
    const pos = lower.indexOf(words[0].toLowerCase());
    const snippet = g.first.text.slice(Math.max(0, pos - 60), (pos < 0 ? 0 : pos) + words[0].length + 120).replace(/\n/g, " ");
    out.push({ path, agent: meta.agent, sid: meta.sid, mtime, count: g.count, snippet });
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

// ---- LLM 1行要約(claude -p / haiku)。直列キュー ----
const summaries = new Map<string, { entryCount: number; text: string }>();
for (const r of db.query(`SELECT key, entry_count, text FROM summaries`).all() as any[])
  summaries.set(r.key, { entryCount: r.entry_count, text: r.text });
postMessage({ type: "summariesAll", list: [...summaries.entries()].map(([key, v]) => ({ key, text: v.text })) });

const sumQueue: { key: string; path: string; agent: "claude" | "codex"; force: boolean }[] = [];
const sumQueued = new Set<string>();
let sumRunning = false;
let summarizerAvailable: boolean | undefined;

async function shOut(cmd: string[], input?: string): Promise<string> {
  try {
    const p = Bun.spawn(cmd, { stdin: input ? new TextEncoder().encode(input) : undefined, stderr: "ignore" });
    const out = await new Response(p.stdout).text();
    await p.exited;
    return out;
  } catch { return ""; }
}

async function runSumQueue() {
  if (sumRunning) return;
  sumRunning = true;
  try {
    while (sumQueue.length) {
      const job = sumQueue.shift()!;
      sumQueued.delete(job.key);
      try { await summarizeOne(job); } catch {}
      await Bun.sleep(500);
    }
  } finally { sumRunning = false; }
}

async function summarizeOne(job: { key: string; path: string; agent: "claude" | "codex"; force: boolean }) {
  if (summarizerAvailable === undefined)
    summarizerAvailable = !!(await shOut(["sh", "-c", "command -v claude"])).trim();
  if (!summarizerAvailable) return;
  const entries = readTranscript(job.path, job.agent);
  if (!entries.length) return;
  const prev = summaries.get(job.key);
  const from = prev ? prev.entryCount : Math.max(0, entries.length - 40);
  const fresh = entries.slice(from).slice(-40);
  if (!job.force && prev && fresh.length < 3) return;  // 目立った進展なし
  const body = fresh.map(e => {
    const label = e.role === "tool_use" ? `tool:${e.title}` : e.role;
    return `[${label}] ${e.text.slice(0, 400)}`;
  }).join("\n").slice(0, 12_000);
  const prompt = `あなたはAIコーディングエージェントのセッション監視ダッシュボードの要約器です。
前回までの要約: ${prev?.text ?? "(なし)"}
--- 新しいログ(抜粋) ---
${body}
---
現在の状況を日本語1行(60字以内)で要約してください。何の作業をしていて、直近の結果・エラー・確認待ち事項があれば含めること。出力は要約文のみ。`;
  const out = (await shOut(["claude", "-p", "--model", "haiku", "--no-session-persistence"], prompt)).trim();
  if (!out || out.length > 200) return;
  const text = out.split("\n")[0];
  summaries.set(job.key, { entryCount: entries.length, text });
  db.run(`INSERT INTO summaries(key, entry_count, text, updated_at) VALUES(?, ?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET entry_count = excluded.entry_count, text = excluded.text, updated_at = excluded.updated_at`,
    [job.key, entries.length, text, Date.now()]);
  postMessage({ type: "summary", key: job.key, text });
}

// ---- メッセージディスパッチ ----
self.onmessage = (e: MessageEvent) => {
  const m = e.data;
  // どのハンドラで例外が出ても Worker を落とさない。落ちるとメイン側の
  // postMessage が毎ポーリング例外になり、ダッシュボード全体が止まる。
  try {
    if (m.type === "reindex") void reindex(m.targets);
    else if (m.type === "search") postMessage({ type: "searchResult", id: m.id, hits: searchIndex(m.q) });
    else if (m.type === "summarize") {
      if (sumQueued.has(m.key)) return;
      sumQueued.add(m.key);
      sumQueue.push({ key: m.key, path: m.path, agent: m.agent, force: !!m.force });
      void runSumQueue();
    }
  } catch (err: any) {
    postMessage({ type: "log", msg: `worker ${m?.type} 失敗: ${err?.message ?? err}` });
    if (m?.type === "search") postMessage({ type: "searchResult", id: m.id, hits: null });
  }
};
