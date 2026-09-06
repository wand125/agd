import { test, expect, describe } from "bun:test";
import { parseClaudeLines, parseCodexLines, truncateEntry, TRUNCATE_AT } from "../web/transcript";

const jl = (...objs: unknown[]) => objs.map(o => JSON.stringify(o));

describe("parseClaudeLines", () => {
  test("ユーザーとアシスタントの発言を拾う", () => {
    const lines = jl(
      { type: "user", timestamp: "t1", message: { content: "hello" } },
      { type: "assistant", timestamp: "t2", message: { content: [{ type: "text", text: "hi" }] } },
    );
    expect(parseClaudeLines(lines)).toEqual([
      { role: "user", text: "hello", ts: "t1" },
      { role: "assistant", text: "hi", ts: "t2" },
    ]);
  });

  test("thinking と tool_use を種別ごとに分ける", () => {
    const lines = jl({
      type: "assistant",
      message: {
        content: [
          { type: "thinking", thinking: "考え中" },
          { type: "tool_use", name: "Bash", input: { command: "ls" } },
        ],
      },
    });
    const e = parseClaudeLines(lines);
    expect(e[0]?.role).toBe("thinking");
    expect(e[1]?.role).toBe("tool_use");
    expect(e[1]?.title).toBe("Bash");
    expect(e[1]?.text).toContain("ls");
  });

  test("tool_result を配列形式でも文字列形式でも読む", () => {
    const lines = jl(
      { type: "user", message: { content: [{ type: "tool_result", content: "plain" }] } },
      { type: "user", message: { content: [{ type: "tool_result", content: [{ text: "a" }, { text: "b" }] }] } },
    );
    const e = parseClaudeLines(lines);
    expect(e[0]).toMatchObject({ role: "tool_result", text: "plain" });
    expect(e[1]?.text).toBe("a\nb");
  });

  // UI に出すと邪魔なだけの内部メッセージ
  test("スラッシュコマンドのローカル出力は除外する", () => {
    const lines = jl(
      { type: "user", message: { content: [{ type: "text", text: "<local-command-stdout>x" }] } },
      { type: "user", message: { content: [{ type: "text", text: "<command-name>/compact" }] } },
    );
    expect(parseClaudeLines(lines)).toEqual([]);
  });

  test("空文字や空白だけの発言は捨てる", () => {
    const lines = jl(
      { type: "user", message: { content: "   " } },
      { type: "assistant", message: { content: [{ type: "text", text: "" }] } },
    );
    expect(parseClaudeLines(lines)).toEqual([]);
  });

  // 書き込み途中の行を読むと壊れた JSON が来る。ここで落ちると一覧全体が死ぬ
  test("壊れた JSON 行を飛ばして続行する", () => {
    const lines = ["{ broken", ...jl({ type: "user", message: { content: "ok" } }), ""];
    expect(parseClaudeLines(lines)).toEqual([{ role: "user", text: "ok", ts: undefined }]);
  });
});

describe("parseCodexLines", () => {
  test("user/assistant/reasoning/function_call を読む", () => {
    const lines = jl(
      { type: "response_item", timestamp: "t1", payload: { type: "message", role: "user", content: "q" } },
      { type: "response_item", payload: { type: "message", role: "assistant", content: [{ text: "a" }] } },
      { type: "response_item", payload: { type: "reasoning", summary: [{ summary_text: "think" }] } },
      { type: "response_item", payload: { type: "function_call", name: "shell", arguments: "{}" } },
      { type: "response_item", payload: { type: "function_call_output", output: "done" } },
    );
    expect(parseCodexLines(lines).map(e => e.role)).toEqual([
      "user", "assistant", "thinking", "tool_use", "tool_result",
    ]);
  });

  test("response_item 以外は無視する", () => {
    const lines = jl({ type: "session_meta", payload: { type: "message", role: "user", content: "x" } });
    expect(parseCodexLines(lines)).toEqual([]);
  });

  test("環境コンテキストと中断通知は表示しない", () => {
    const lines = jl(
      { type: "response_item", payload: { type: "message", role: "user", content: "<environment_context>..." } },
      { type: "response_item", payload: { type: "message", role: "user", content: "<turn_aborted>" } },
    );
    expect(parseCodexLines(lines)).toEqual([]);
  });

  test("壊れた JSON 行を飛ばして続行する", () => {
    const lines = ["nope", ...jl({ type: "response_item", payload: { type: "message", role: "user", content: "ok" } })];
    expect(parseCodexLines(lines)).toHaveLength(1);
  });
});

describe("truncateEntry", () => {
  test("短いものはそのまま返す", () => {
    const e = { role: "user", text: "short" };
    expect(truncateEntry(e)).toBe(e);
    expect(truncateEntry(e).truncated).toBeUndefined();
  });

  test("長いものは切り詰めて truncated を立てる", () => {
    const r = truncateEntry({ role: "user", text: "x".repeat(TRUNCATE_AT + 100) });
    expect(r.text).toHaveLength(TRUNCATE_AT);
    expect(r.truncated).toBe(true);
  });

  test("境界ちょうどでは切らない", () => {
    const r = truncateEntry({ role: "user", text: "x".repeat(TRUNCATE_AT) });
    expect(r.truncated).toBeUndefined();
  });
});

// codex の /clear と /compact は "compacted" 行を書き、それ以前の履歴は
// replacement_history に置き換えられる。無視すると clear した直後でも
// 過去の会話が並んだままになり、画面(空)とログ(過去の会話)が食い違う。
describe("codex の /clear (compacted)", () => {
  const msg = (role: string, text: string) => JSON.stringify({
    type: "response_item", timestamp: "2026-09-06T00:00:00Z",
    payload: { type: "message", role, content: [{ text }] },
  });
  const compacted = JSON.stringify({
    type: "compacted", timestamp: "2026-09-06T00:00:00Z",
    payload: { message: "", replacement_history: [] },
  });

  test("compacted より前の履歴は出さない", () => {
    const e = parseCodexLines([msg("user", "clear前A"), msg("assistant", "clear前B"), compacted, msg("user", "clear後")]);
    expect(e.map(x => x.text)).toEqual(["clear後"]);
  });

  test("compacted が複数あれば最後のもの以降だけ残る", () => {
    const e = parseCodexLines([msg("user", "1回目前"), compacted, msg("user", "2回目前"), compacted, msg("user", "最新")]);
    expect(e.map(x => x.text)).toEqual(["最新"]);
  });

  test("compacted が無ければ全部残る", () => {
    const e = parseCodexLines([msg("user", "A"), msg("assistant", "B")]);
    expect(e.map(x => x.text)).toEqual(["A", "B"]);
  });

  // clear 直後でログが空になるのは正しい(画面も空)
  test("compacted の後に何も無ければ空", () => {
    expect(parseCodexLines([msg("user", "前"), compacted])).toEqual([]);
  });
});
