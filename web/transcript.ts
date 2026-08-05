// トランスクリプト(claude jsonl / codex rollout)の共通パーサーと増分読み込みキャッシュ。
// server.ts(メインスレッド)と search-worker.ts(Worker)の両方から使う。
// それぞれのスレッドが自分のキャッシュインスタンスを持つ(モジュールはスレッドごとに評価される)。
import { statSync, openSync, readSync, closeSync } from "fs";

export type LogEntry = { role: string; title?: string; text: string; ts?: string };

export function parseClaudeLines(lines: string[]): LogEntry[] {
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

export function parseCodexLines(lines: string[]): LogEntry[] {
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

export const TRUNCATE_AT = 4000;
export function truncateEntry(e: LogEntry): LogEntry & { truncated?: boolean } {
  if (e.text.length <= TRUNCATE_AT) return e;
  return { ...e, text: e.text.slice(0, TRUNCATE_AT), truncated: true };
}
