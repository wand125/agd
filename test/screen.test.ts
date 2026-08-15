import { test, expect, describe } from "bun:test";
import { parseTmuxPanes, detectPrompt, detectAskPrompt, TMUX_PANE_FORMAT } from "../web/screen";

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

  // idle のセッションで、過去に打ったコマンドのエコー(❯ /compact)と
  // その下の ⎿ 結果行を選択肢として拾ってしまい、待機していないのに
  // 応答ボタンが出ていた(実際の画面から採取)
  describe("スクロールバックの誤検出", () => {
    const idleScreen = [
      "✻ Churned for 40s",
      "",
      "❯ /compact",
      "  ⎿  Compacted (ctrl+o to see full summary)",
      "  ⎿  Read ../../../../.claude/RTK.md (30 lines)",
      "  ⎿  Read docs/設計メモ/データ取り込み_仕様まとめ.md (94 lines)",
      "  ⎿  Referenced file tasks/index.md",
      "",
      "⏺ Remote Control disconnected — run /login to restore",
      "",
      "─".repeat(60),
      "❯ ",
      "─".repeat(60),
      "  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents",
    ].join("\n");

    test("入力欄より上のコマンドエコーを選択肢にしない", () => {
      expect(detectPrompt(idleScreen)?.options ?? []).toEqual([]);
    });

    test("ツール結果行(⎿)は選択肢にならない", () => {
      const p = detectPrompt(idleScreen);
      const labels = (p?.options ?? []).map(o => o.label);
      expect(labels.some(l => l.includes("Read ") || l.includes("Compacted"))).toBe(false);
    });
  });

  // 横に並んだ別パネルの文章が同じ行に入り、選択肢ラベルに流れ込んでいた
  test("右側の別パネルの文字をラベルに混ぜない", () => {
    const screen = [
      "どちらで進めますか?",
      " ❯ 1. エクスポーターを新規作成    │ （パスをご指定ください）",
      "   2. ページング機能を追加        │ 探した場所:",
      "   3. 既存の場所を教える          │ ~/.discord-mcp/",
    ].join("\n");
    const p = detectPrompt(screen);
    expect(p?.kind).toBe("numbered");
    expect(p?.options.map(o => o.label)).toEqual([
      "エクスポーターを新規作成",
      "ページング機能を追加",
      "既存の場所を教える",
    ]);
  });

  // auto mode のセットアップ画面。番号でもカーソル選択でもないため、以前は
  // {options: []} になって UI から一切操作できなかった
  describe("設定フォーム", () => {
    const autoModeScreen = [
      "❯  Set up auto mode for your environment?",
      "",
      "   Claude Code reads this project, your recent Claude sessions, and optionally",
      "  your shell history and other repositories.",
      "",
      "     How you use Claude here    ◀ Mixed ▶",
      "     Also scan shell history    [✔]",
      "   ❯ Also scan your other repos [ ]",
      "",
      "     Continue",
    ].join("\n");

    test("ウィジェット行と確定ボタンを選択肢として返す", () => {
      const p = detectPrompt(autoModeScreen);
      expect(p?.kind).toBe("form");
      expect(p?.question).toBe("Set up auto mode for your environment?");
      expect(p?.options.map(o => o.label)).toEqual([
        "How you use Claude here    ◀ Mixed ▶",
        "Also scan shell history    [✔]",
        "Also scan your other repos [ ]",
        "Continue",
      ]);
    });

    // 見出し行にも "❯" が付くため、単純な findIndex だと 0 になってしまう
    test("カーソル位置は見出しではなく項目行から求める", () => {
      expect(detectPrompt(autoModeScreen)?.cursorIndex).toBe(2);
    });

    test("確定ボタンが無ければフォームとみなさない", () => {
      const p = detectPrompt(["   A [✔]", "   B [ ]"].join("\n"));
      expect(p?.kind).not.toBe("form");
    });

    test("ウィジェット行が1つだけならフォームとみなさない", () => {
      const p = detectPrompt(["   Only one [✔]", "   Continue"].join("\n"));
      expect(p?.kind).not.toBe("form");
    });

    // 通常のカーソル選択がフォーム扱いに化けると Space が飛んで壊れる
    test("素のカーソル選択はフォームにしない", () => {
      expect(detectPrompt(["Select?", " ❯ Yes", "   No"].join("\n"))?.kind).toBe("cursor");
    });
  });
});

// 画面解析はラベルが幅で切れたり、横に並んだパネルの文字が混ざったりする。
// AskUserQuestion は tool_use として構造化されて残るので、そちらを正とする
describe("detectAskPrompt", () => {
  const ask = (id: string, input: any) =>
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "AskUserQuestion", input }] } });
  const result = (id: string) =>
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: "answered" }] } });
  const q1 = {
    questions: [{
      question: "ライセンスはどれにしますか?",
      multiSelect: false,
      options: [
        { label: "MIT (Recommended)", description: "最も一般的で採用されやすい" },
        { label: "Apache-2.0", description: "特許条項付き" },
      ],
    }],
  };

  test("未応答の質問を選択肢として返す", () => {
    const p = detectAskPrompt([ask("t1", q1)]);
    expect(p?.source).toBe("transcript");
    expect(p?.question).toBe("ライセンスはどれにしますか?");
    expect(p?.options.map(o => o.label)).toEqual(["MIT (Recommended)", "Apache-2.0"]);
  });

  // 画面からは取れない情報。ツールチップに出す
  test("description も取れる", () => {
    expect(detectAskPrompt([ask("t1", q1)])?.options[0]?.description).toBe("最も一般的で採用されやすい");
  });

  // 応答済みを拾うと、待機していないセッションにボタンが出てしまう
  test("応答済みの質問は返さない", () => {
    expect(detectAskPrompt([ask("t1", q1), result("t1")])).toBeNull();
  });

  test("応答済みが混ざっていても未応答のものを選ぶ", () => {
    const q2 = { questions: [{ question: "次は?", options: [{ label: "A" }, { label: "B" }] }] };
    const p = detectAskPrompt([ask("t1", q1), result("t1"), ask("t2", q2)]);
    expect(p?.question).toBe("次は?");
  });

  test("multiSelect を保持する", () => {
    const m = { questions: [{ question: "どれ?", multiSelect: true, options: [{ label: "A" }, { label: "B" }] }] };
    expect(detectAskPrompt([ask("t1", m)])?.multiSelect).toBe(true);
  });

  test("AskUserQuestion が無ければ null", () => {
    expect(detectAskPrompt(["", "{}", "壊れたJSON"])).toBeNull();
  });

  test("壊れた行があっても落ちない", () => {
    expect(() => detectAskPrompt(["{AskUserQuestion 壊れてる", ask("t1", q1)])).not.toThrow();
    expect(detectAskPrompt(["{AskUserQuestion 壊れてる", ask("t1", q1)])?.options.length).toBe(2);
  });
});
