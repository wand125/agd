// トランスクリプト(claude jsonl / codex rollout)の共通パーサーと増分読み込みキャッシュ。
// server.ts(メインスレッド)と search-worker.ts(Worker)の両方から使う。
// それぞれのスレッドが自分のキャッシュインスタンスを持つ(モジュールはスレッドごとに評価される)。
import { statSync, openSync, readSync, closeSync } from "fs";

export type LogEntry = { role: string; title?: string; text: string; ts?: string };

// 巨大な jsonl をファイル全体ぶん確保せず、完結した行だけを逐次渡す。
// LF は UTF-8 の継続バイトには現れないため、デコード前に探せば文字境界を壊さない。
export function forEachLineChunk(
  path: string,
  byteOffset: number,
  onLines: (lines: string[]) => void,
  chunkBytes = 1024 * 1024,
): number {
  const buf = Buffer.alloc(chunkBytes);
  const fd = openSync(path, "r");
  // 書きかけ行の断片。1 行がチャンクを超えるときは断片を配列に溜め、改行が見つかった
  // ときに 1 回だけ連結する。毎チャンク連結し直すと、20MB の行(実在する)で
  // 増え続けるコピーが何十回も走り、mimalloc が返さない領域が積み上がる
  let carry: Buffer[] = [];
  let carryLen = 0;
  let readOffset = byteOffset;
  let completeOffset = byteOffset;
  try {
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, readOffset);
      if (n === 0) break;
      readOffset += n;
      const chunk = buf.subarray(0, n);
      const lastNl = chunk.lastIndexOf(0x0a);
      if (lastNl < 0) {
        carry.push(Buffer.from(chunk));
        carryLen += n;
        continue;
      }
      const head = chunk.subarray(0, lastNl);
      const bytes = carry.length ? Buffer.concat([...carry, head], carryLen + head.length) : head;
      carry = [];
      carryLen = 0;
      const lines = bytes.toString("utf8").split("\n").filter(Boolean);
      if (lines.length) onLines(lines);
      const rest = chunk.subarray(lastNl + 1);
      if (rest.length) { carry.push(Buffer.from(rest)); carryLen = rest.length; }
      completeOffset = readOffset - carryLen;
    }
    return completeOffset;
  } finally {
    closeSync(fd);
  }
}

// メタ情報の抽出では先頭だけで足りるため、巨大ファイル全体を一時確保しない。
export function readHead(path: string, maxBytes: number): string {
  const buf = Buffer.alloc(maxBytes);
  const fd = openSync(path, "r");
  try {
    const n = readSync(fd, buf, 0, buf.length, 0);
    return buf.toString("utf8", 0, n);
  } finally {
    closeSync(fd);
  }
}

// entries を渡すとそこへ追記する(チャンク読みで配列をまたいで状態を持つため)。
// codex の compacted は「それ以前を全部捨てる」なので、呼び出し側が溜めている
// 配列そのものを空にしないと、前のチャンクや前回の追記分が残ってしまう
export function parseClaudeLines(lines: string[], entries: LogEntry[] = []): LogEntry[] {
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

export function parseCodexLines(lines: string[], entries: LogEntry[] = []): LogEntry[] {
  const textOf = (content: any): string => {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) return content.map((x: any) => x.text ?? x.summary_text ?? "").filter(Boolean).join("\n");
    return "";
  };
  for (const l of lines) {
    let o: any; try { o = JSON.parse(l); } catch { continue; }
    // /clear と /compact は "compacted" 行を書き、それ以前の履歴は
    // replacement_history に置き換えられる。つまりこの行より前は破棄された
    // 内容なので、ログにも出さない。無視すると clear した直後でも
    // 過去の会話が並んだままになる(実際にそうなっていた)
    if (o.type === "compacted") { entries.length = 0; continue; }
    if (o.type !== "response_item") continue;
    const p = o.payload; if (!p) continue;
    const ts = o.timestamp;
    if (p.type === "message") {
      if (p.role === "user") {
        const t = textOf(p.content);
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

export function readTranscript(path: string, agent: "claude" | "codex"): LogEntry[] {
  let st;
  try { st = statSync(path); } catch { return []; }
  let c = transcriptCache.get(path);
  if (!c || st.size < c.offset) c = { offset: 0, entries: [] };  // 縮んだら作り直し
  if (st.size > c.offset) {
    try {
      // c.entries に直接追記する。spread で積むと compacted のリセットが効かず、
      // 巨大な配列の spread はそれ自体がスタックを食う
      const entries = c.entries;
      c.offset = forEachLineChunk(path, c.offset, lines => {
        if (agent === "claude") parseClaudeLines(lines, entries); else parseCodexLines(lines, entries);
      });
    } catch {}
  }
  transcriptCache.delete(path);           // LRU: 触ったものを末尾へ
  transcriptCache.set(path, c);
  while (transcriptCache.size > TRANSCRIPT_CACHE_MAX)
    transcriptCache.delete(transcriptCache.keys().next().value!);
  return c.entries;
}

export const TRUNCATE_AT = 4000;
export function truncateEntry(e: LogEntry): LogEntry & { truncated?: boolean } {
  if (e.text.length <= TRUNCATE_AT) return e;
  return { ...e, text: e.text.slice(0, TRUNCATE_AT), truncated: true };
}
