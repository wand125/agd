import { test, expect, describe } from "bun:test";
import { parseTmuxPanes, detectPrompt, TMUX_PANE_FORMAT } from "../web/screen";

describe("parseTmuxPanes", () => {
  test("パイプ区切りの通常出力を解析する", () => {
    const out = "/dev/ttys051|%2|agd-x:0.0\n/dev/ttys049|%0|mobile:0.0\n";
    expect(parseTmuxPanes(out)).toEqual([
      { tty: "ttys051", paneId: "%2", target: "agd-x:0.0" },
      { tty: "ttys049", paneId: "%0", target: "mobile:0.0" },
    ]);
  });

  test("空の出力で落ちない", () => {
    expect(parseTmuxPanes("")).toEqual([]);
    expect(parseTmuxPanes("\n\n")).toEqual([]);
  });

  // 回帰テスト: tmux はロケール未設定(LANG が無い launchd 配下など)だと
  // -F のタブを印字不能文字とみなして "_" に置換する。以前は区切りにタブを
  // 使っていたため列が分割できず、ペインを1つも認識できないまま
  // 「画面が空・送信が届かない」状態になっていた(エラーは出ない)。
  test("区切り文字にタブを使わない", () => {
    expect(TMUX_PANE_FORMAT).not.toContain("\t");
    expect(TMUX_PANE_FORMAT).toContain("|");
  });

  test("区切りが壊れた行は捨てる(黙って通さない)", () => {
    // ロケール由来でタブが "_" に潰れた出力
    const broken = "/dev/ttys051_%2_agd-x:0.0\n";
    expect(parseTmuxPanes(broken)).toEqual([]);
  });

  test("target が欠けていても tty と paneId は取れる", () => {
    expect(parseTmuxPanes("/dev/ttys1|%9")).toEqual([
      { tty: "ttys1", paneId: "%9", target: "" },
    ]);
  });
});

describe("detectPrompt", () => {
  test("画面が無ければ null", () => {
    expect(detectPrompt(undefined)).toBeNull();
    expect(detectPrompt("")).toBeNull();
  });

  test("番号付き選択肢(Claude の許可プロンプト)を検出する", () => {
    const screen = [
      "Do you want to proceed?",
      " ❯ 1. Yes",
      "   2. Yes, and don't ask again",
      "   3. No",
    ].join("\n");
    const p = detectPrompt(screen);
    expect(p?.kind).toBe("numbered");
    expect(p?.question).toBe("Do you want to proceed?");
    expect(p?.options.map(o => o.key)).toEqual(["1", "2", "3"]);
    expect(p?.options[0]?.label).toBe("Yes");
    expect(p?.cursorIndex).toBe(0);
  });

  test("カーソルが2番目にあれば cursorIndex に反映される", () => {
    const screen = ["Pick one?", "   1. A", " ❯ 2. B"].join("\n");
    expect(detectPrompt(screen)?.cursorIndex).toBe(1);
  });

  test("ANSI カラーが付いていても検出できる", () => {
    const screen = [
      "\x1b[1mContinue?\x1b[0m",
      "\x1b[32m ❯ 1. Yes\x1b[0m",
      "\x1b[32m   2. No\x1b[0m",
    ].join("\n");
    const p = detectPrompt(screen);
    expect(p?.kind).toBe("numbered");
    expect(p?.options[0]?.label).toBe("Yes");
  });

  test("codex の › カーソルも受け付ける", () => {
    const screen = ["Allow command?", " › 1. Yes", "   2. No"].join("\n");
    expect(detectPrompt(screen)?.kind).toBe("numbered");
  });

  test("番号なしのカーソル選択を検出する", () => {
    const screen = ["Select an option?", " ❯ Yes", "   No"].join("\n");
    const p = detectPrompt(screen);
    expect(p?.kind).toBe("cursor");
    expect(p?.options.map(o => o.label)).toEqual(["Yes", "No"]);
    expect(p?.cursorIndex).toBe(0);
  });

  // 入力欄の "❯" をプロンプトと誤検出すると、待機していないセッションに
  // 応答ボタンが出てしまう
  test("空の入力プロンプトは選択肢にしない", () => {
    expect(detectPrompt("❯ ")).toBeNull();
    expect(detectPrompt("\n❯\n")).toBeNull();
  });

  test("選択肢が1つだけなら選択肢として返さない", () => {
    const p = detectPrompt(["❯ 1. Only", "some other text"].join("\n"));
    expect(p?.kind).not.toBe("numbered");
  });

  test("画面末尾だけを見る(古いプロンプトを拾わない)", () => {
    const old = ["❯ 1. Yes", "   2. No"].join("\n");
    const filler = Array.from({ length: 30 }, (_, i) => `output line ${i}`).join("\n");
    expect(detectPrompt(`${old}\n${filler}`)).toBeNull();
  });
});
