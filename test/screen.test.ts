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

// 画面と転記で選択肢の数がずれることがある(画面がスクロールしていたり、
// 幅が狭くて末尾が見えていない場合)。以前は件数一致を条件に転記を採用して
// いたため、ずれた瞬間だけ幅で切れたラベルに戻っていた。
// applyPrompts の合流規則をここで固定する(server.ts は import すると
// サーバーが起動するため、同じ式を書き写して検証する)。
describe("画面と転記の合流", () => {
  const merge = (p: any, ask: any) => {
    const cursor = p?.cursorIndex ?? 0;
    return ask ? { ...ask, cursorIndex: cursor < ask.options.length ? cursor : 0 } : p;
  };
  const opts = (n: number, pre: string) =>
    Array.from({ length: n }, (_, i) => ({ key: String(i + 1), label: `${pre}${i + 1}` }));

  test("件数がずれても転記のラベルを使う", () => {
    const p = { options: opts(3, "画面"), cursorIndex: 1 };
    const ask = { options: opts(4, "転記"), source: "transcript" };
    const m = merge(p, ask);
    expect(m.source).toBe("transcript");
    expect(m.options).toHaveLength(4);
    expect(m.options[0].label).toBe("転記1");
  });

  test("カーソル位置は画面の値を引き継ぐ", () => {
    const m = merge({ options: opts(4, "画面"), cursorIndex: 2 }, { options: opts(4, "転記") });
    expect(m.cursorIndex).toBe(2);
  });

  // 画面に見えている位置が転記の件数を超えることがある。
  // そのまま使うと存在しない行を選びに行ってしまう
  test("カーソルが転記の範囲外なら先頭に倒す", () => {
    const m = merge({ options: opts(5, "画面"), cursorIndex: 4 }, { options: opts(3, "転記") });
    expect(m.cursorIndex).toBe(0);
  });

  test("転記が取れなければ画面のものを使う", () => {
    const p = { options: opts(3, "画面"), cursorIndex: 1 };
    expect(merge(p, null)).toBe(p);
  });
});

// 選択肢の下に並ぶ操作(Chat about this / Submit など)は AskUserQuestion の
// トランスクリプトには現れない。転記を正にする実装では、ここを画面から
// 別に拾わないとボタンごと消えてしまう。
describe("選択肢以外の操作(extras)", () => {
  const screen = (cursor: number) => [
    "どちらで進めますか。",
    "",
    ...[1, 2, 3].map(n => `${cursor === n - 1 ? " ❯ " : "   "}${n}. 選択肢${n}`),
    "",
    "   Chat about this",
    "",
    "   Submit",
    "",
    " Enter to select · ↑/↓ to navigate",
  ].join("\n");

  test("選択肢の下の操作行を拾う", () => {
    const p = detectPrompt(screen(2));
    expect(p?.extras?.map(x => x.label)).toEqual(["Chat about this", "Submit"]);
  });

  test("選択肢そのものは extras に混ざらない", () => {
    const p = detectPrompt(screen(0));
    expect(p?.options).toHaveLength(3);
    expect(p?.extras?.some(x => /選択肢/.test(x.label))).toBe(false);
  });

  // 番号キーでは選べないので、カーソルを送る回数を位置から計算する必要がある
  test("押すキーはカーソル位置に応じて変わる", () => {
    const down = (cursor: number, i: number) =>
      detectPrompt(screen(cursor))!.extras![i].keys.filter(k => k === "Down").length;
    expect(down(2, 0)).toBe(1);   // 最終選択肢にいる → 1つ下が Chat about this
    expect(down(0, 0)).toBe(3);   // 先頭にいる → 2つ進んでさらに1つ下
    expect(down(2, 1)).toBe(2);   // Submit はその次
  });

  test("最後は Enter で確定する", () => {
    const keys = detectPrompt(screen(2))!.extras![0].keys;
    expect(keys[keys.length - 1]).toBe("Enter");
  });

  test("操作行が無ければ空", () => {
    const p = detectPrompt(["選ぶ?", " ❯ 1. A", "   2. B"].join("\n"));
    expect(p?.extras ?? []).toEqual([]);
  });
});

// AskUserQuestion は1回の tool_use に複数の質問を持てて、TUI は1問ずつ順に出す。
// questions[0] 固定だと、2問目に進んでも1問目を出し続けて「切り替わらない」。
// 実データでは複数質問のものが71件あった。
describe("複数質問の AskUserQuestion", () => {
  const line = JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "t1", name: "AskUserQuestion", input: { questions: [
      { question: "Q1: 表示場所は?", options: [{ label: "ヘッダーに出す" }, { label: "サイドバーに出す" }] },
      { question: "Q2: 反映範囲は?", options: [{ label: "この画面だけ" }, { label: "全画面に反映" }] },
    ] } }] },
  });

  test("画面に出ている選択肢と一致する質問を選ぶ", () => {
    const p = detectAskPrompt([line], ["この画面だけ", "全画面に反映"]);
    expect(p?.question).toBe("Q2: 反映範囲は?");
    expect(p?.options.map(o => o.label)).toEqual(["この画面だけ", "全画面に反映"]);
  });

  test("1問目が出ているならそちらを選ぶ", () => {
    expect(detectAskPrompt([line], ["ヘッダーに出す", "サイドバーに出す"])?.question)
      .toBe("Q1: 表示場所は?");
  });

  // 画面側のラベルは幅で切れることがある。完全一致を求めると当たらない
  test("画面のラベルが途中で切れていても一致させる", () => {
    expect(detectAskPrompt([line], ["この画面だ", "全画面に反"])?.question)
      .toBe("Q2: 反映範囲は?");
  });

  test("手がかりが無ければ先頭の質問", () => {
    expect(detectAskPrompt([line])?.question).toBe("Q1: 表示場所は?");
  });

  // 選択肢が1つしかない質問は操作の対象にならない
  test("選択肢が足りない質問は候補から外す", () => {
    const l = JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t2",
      name: "AskUserQuestion", input: { questions: [
        { question: "壊れ", options: [{ label: "唯一" }] },
        { question: "有効", options: [{ label: "A" }, { label: "B" }] },
      ] } }] } });
    expect(detectAskPrompt([l])?.question).toBe("有効");
  });
});

// 複数選択の画面では Submit が選択肢の途中(Chat about this より上)に
// 置かれることがある。「最後の選択肢より下」だけを見ていたため拾えず、
// チェックは付けられるのに確定できなかった。
describe("選択肢の途中にある Submit", () => {
  const screen = (cursor: number) => [
    "どの観点を中心にしますか？",
    "",
    ...[1, 2, 3, 4, 5].map(n => `${cursor === n - 1 ? "❯ " : "  "}${n}. [ ] 選択肢${n}`),
    "     Submit",
    "────────",
    "  6. Chat about this",
  ].join("\n");

  test("Submit を操作として拾う", () => {
    expect(detectPrompt(screen(0))?.extras?.map(x => x.label)).toEqual(["Submit"]);
  });

  // カーソルは選択肢と操作行を順に通るので、通し位置で数える必要がある
  test("送るキー数がカーソル位置に追従する", () => {
    const down = (c: number) =>
      detectPrompt(screen(c))!.extras![0].keys.filter(k => k === "Down").length;
    expect(down(0)).toBe(5);   // 選択肢1 → 5つ下が Submit
    expect(down(4)).toBe(1);   // 選択肢5 → すぐ下
  });

  // ラベルがチェックボックスなら、数字は ON/OFF で確定に Enter が要る。
  // 転記が取れない場面でも確定手段を出せるよう画面から判定する
  test("チェックボックスが並べば複数選択とみなす", () => {
    expect(detectPrompt(screen(0))?.multiSelect).toBe(true);
  });

  test("チェックが1つ以下なら複数選択にしない", () => {
    expect(detectPrompt(["選ぶ?", "❯ 1. [✔] A", "  2. 普通"].join("\n"))?.multiSelect).toBeUndefined();
    expect(detectPrompt(["選ぶ?", "❯ 1. はい", "  2. いいえ"].join("\n"))?.multiSelect).toBeUndefined();
  });
});
