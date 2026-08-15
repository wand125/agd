// 画面テキストと tmux 出力の解析。
//
// ここには外部プロセスや I/O を持ち込まない(server.ts を import すると
// サーバーが起動してしまうため、テストから触れる純粋関数だけを置く)。

export type PromptInfo = {
  question?: string;
  options: { key: string; label: string; description?: string }[];
  kind?: "numbered" | "cursor" | "form";   // cursor: 矢印+Enterで選ぶ形式 / form: 複数項目を設定して確定
  cursorIndex?: number;           // cursor/form での現在のカーソル行
  // トランスクリプト由来(AskUserQuestion)。画面解析と違いラベルが確実で
  // description も取れる。ただし選択の実行は結局キー送信なので、
  // カーソル位置だけは画面から補う必要がある
  source?: "screen" | "transcript";
  multiSelect?: boolean;
};

export type TmuxPane = { tty: string; paneId: string; target: string };

// 区切りはタブではなく "|" を使う。
// tmux はロケール未設定(LANG が無い環境)だとタブを印字不能文字とみなして "_" に
// 置換するため、launchd から起動された agd では \t 区切りが壊れてペインを1つも
// 認識できなかった。"|" は tmux が加工しないうえ tty/pane_id/session 名に現れない
export const TMUX_PANE_FORMAT = "#{pane_tty}|#{pane_id}|#{session_name}:#{window_index}.#{pane_index}";

export function parseTmuxPanes(out: string): TmuxPane[] {
  return out.trim().split("\n").filter(Boolean).flatMap(l => {
    const [tty, paneId, target] = l.split("|");
    // pane_id が無い行は形式が壊れている(ロケール由来のタブ置換など)。
    // 黙って壊れた行を通すと tty 照合が全滅するので落とす
    if (!tty || !paneId) return [];
    return [{ tty: tty.replace("/dev/", ""), paneId, target: target ?? "" }];
  });
}

// ---------------------------------------------------------------- 選択プロンプト検出
// Claude の許可プロンプト/AskUserQuestion は「❯ 1. Yes」形式の番号付き選択肢、
// codex 等は「❯ Yes」形式のカーソル選択。画面末尾から検出する。
export function detectPrompt(screen: string | undefined): PromptInfo | null {
  if (!screen) return null;
  // 画面テキストは ANSI カラー付きで来るためパターン照合前に除去する
  const plain = screen
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "")
    .replace(/\x00/g, " ");
  // カーソル記号は claude の ❯(U+276F)と codex の ›(U+203A)の両方を受け付ける
  // 横に並んだ別パネル(ノート欄など)が同じ行に混ざる。│ を空白に潰すだけだと
  // 右側のパネルの文章がそのまま選択肢ラベルに流れ込むため、最初の縦罫線より
  // 右は切り捨てる。ただし行頭の枠線は本文の左端なので対象外
  const lines = plain.split("\n").slice(-18).map(l => {
    const cut = l.replace(/^\s*[│┃]/, m => " ".repeat(m.length)).search(/[│┃╭╮╰╯┌┐└┘]/);
    return (cut > 0 ? l.slice(0, cut) : l).replace(/[│┃]/g, " ").trimEnd();
  });
  const optRe = /^\s*([❯›])?\s*(\d+)\.\s+(.+)$/;
  const opts: { key: string; label: string }[] = [];
  let hasCursor = false, firstIdx = -1, numCursorIdx = 0;
  lines.forEach((l, i) => {
    const m = l.match(optRe);
    if (m) {
      if (opts.length === 0) firstIdx = i;
      if (m[1]) { hasCursor = true; numCursorIdx = opts.length; }
      opts.push({ key: m[2]!, label: m[3]!.trim().slice(0, 70) });
    }
  });
  const findQuestion = (above: number): string | undefined => {
    for (let i = above - 1; i >= 0 && i > above - 7; i--) {
      const t = (lines[i] ?? "").trim();
      if (/[??]$/.test(t)) return t.slice(0, 120);
    }
    return undefined;
  };
  if (opts.length >= 2 && hasCursor)
    return { question: findQuestion(firstIdx), options: opts.slice(0, 8), kind: "numbered", cursorIndex: numCursorIdx };
  // 設定フォーム(auto mode のセットアップ画面など)。行が「選択肢」ではなく
  // ウィジェット(◀ 値 ▶ / [✔] / [ ])を持つ設定項目で、上下に動いて個別に
  // 切り替えたうえで最後に Continue を押す。番号もカーソル選択も当たらないため
  // これまでは {options: []} になり、UI に何も出せなかった
  const form = detectForm(lines);
  if (form) return form;
  // 非番号のカーソル選択(❯ Yes 形式)。空の入力プロンプト(❯ のみ)は除外。
  //
  // ただし入力欄(──── で挟まれた ❯)より上は「過去に打ったコマンドのエコー」で、
  // 生きたカーソルではない。ここを拾うと idle のセッションで
  // 「❯ /compact」+ 直後の ⎿ 結果行が選択肢に化ける(実際に誤検出していた)。
  // 入力欄の位置が分かる場合はそれより下だけを見る
  const inputAt = lines.findIndex(l => /^[─━]{20,}$/.test(l.trim()));
  const searchFrom = inputAt >= 0 ? inputAt : 0;
  const cursorIdx = lines.findIndex((l, i) =>
    i >= searchFrom && /^\s*[❯›]\s+\S/.test(l) && !optRe.test(l));
  if (cursorIdx >= 0) {
    // カーソル行の上下に連続する「選択肢らしい行」をブロックとして解析
    const isOpt = (l: string | undefined) => {
      const t = (l ?? "").replace(/^\s*[❯›]?\s*/, "").trim();
      return t.length > 0 && t.length <= 80 &&
        !/[??]$/.test(t) &&                       // 質問文
        !/[┌┐└┘─╭╮╰╯═━]/.test(t) &&               // 罫線
        !/^[⎿⏺✻·]/.test(t) &&                     // ツール結果・状態行(選択肢ではない)
        !/^\//.test(t) &&                         // 打ち込んだスラッシュコマンドのエコー
        !/ · |^Esc |^Press |^ctrl|^Tab /i.test(t); // 操作ヒント行
    };
    let start = cursorIdx, end = cursorIdx;
    while (start > 0 && isOpt(lines[start - 1])) start--;
    while (end < lines.length - 1 && isOpt(lines[end + 1])) end++;
    const copts: { key: string; label: string }[] = [];
    for (let i = start; i <= end; i++)
      copts.push({ key: `opt:${i - start}`, label: (lines[i] ?? "").replace(/^\s*[❯›]?\s*/, "").trim().slice(0, 70) });
    if (copts.length >= 2 && copts.length <= 8)
      return { question: findQuestion(start), options: copts, kind: "cursor", cursorIndex: cursorIdx - start };
    return { options: [] };
  }
  return null;
}

// ------------------------------------------------- トランスクリプト由来の選択肢
// AskUserQuestion は tool_use としてトランスクリプトに構造化されて残る。
// 画面解析と違い ANSI も列崩れも幅切れも無く、description まで取れるため、
// 選択肢が取れる場面ではこちらを正とする。
//
// 「未応答か」は、対応する tool_result がまだ書かれていないことで判定する。
// 応答済みのものを拾うと、待機していないセッションにボタンが出てしまう。
export function detectAskPrompt(lines: string[]): PromptInfo | null {
  const asks = new Map<string, any>();
  const answered = new Set<string>();
  for (const l of lines) {
    // JSON.parse は高くつくので、関係する行だけに絞ってから解く
    if (!l.includes("AskUserQuestion") && !l.includes("tool_result")) continue;
    let o: any; try { o = JSON.parse(l); } catch { continue; }
    const c = o?.message?.content;
    if (!Array.isArray(c)) continue;
    for (const b of c) {
      if (!b || typeof b !== "object") continue;
      if (b.type === "tool_use" && b.name === "AskUserQuestion" && b.id) asks.set(b.id, b.input);
      else if (b.type === "tool_result" && b.tool_use_id) answered.add(b.tool_use_id);
    }
  }
  // 最後の未応答のものが「今聞かれていること」
  let pending: any = null;
  for (const [id, input] of asks) if (!answered.has(id)) pending = input;
  const q = pending?.questions?.[0];
  if (!q || !Array.isArray(q.options) || q.options.length < 2) return null;
  return {
    question: typeof q.question === "string" ? q.question.slice(0, 120) : undefined,
    options: q.options.slice(0, 8).map((o: any, i: number) => ({
      key: String(i + 1),
      label: String(o?.label ?? "").slice(0, 70),
      description: typeof o?.description === "string" ? o.description.slice(0, 200) : undefined,
    })),
    kind: "numbered",
    cursorIndex: 0,
    source: "transcript",
    multiSelect: !!q.multiSelect,
  };
}

// 設定フォームの行を拾う。ウィジェットの形でしか判定しない(ラベル文字列に
// 依存すると英語版以外や文言変更で黙って壊れるため)
const FORM_WIDGET = /(◀\s*.+?\s*▶|\[[ xX✔✓*]\])\s*$/;
// 確定ボタン。カーソルを合わせて Enter を押す行で、ウィジェットを持たない
const FORM_SUBMIT = /^(Continue|Confirm|Done|OK|Save|Submit|続ける|確定|完了|保存)$/i;

function detectForm(lines: string[]): PromptInfo | null {
  const strip = (l: string) => (l ?? "").replace(/^\s*[❯›]\s*/, "").trim();
  const rows: { key: string; label: string; line: number }[] = [];
  let submit = -1;
  lines.forEach((l, i) => {
    const t = strip(l);
    if (!t) return;
    if (FORM_WIDGET.test(t)) rows.push({ key: `form:${rows.length}`, label: t.slice(0, 70), line: i });
    else if (FORM_SUBMIT.test(t)) submit = i;
  });
  // ウィジェット行が2つ以上、かつ確定ボタンがある場合だけフォームと見なす。
  // 片方でも欠けると、単なる文章や表を誤検出しかねない
  if (rows.length < 2 || submit < 0) return null;
  rows.push({ key: `form:${rows.length}`, label: strip(lines[submit]!).slice(0, 70), line: submit });
  // カーソルは項目行にも確定ボタン行にも乗りうる。フォーム全体の見出しにも "❯"
  // が付くことがあるので、行番号ではなく「フォームの行のうちカーソル付きのもの」を探す
  const idx = rows.findIndex(r => /^\s*[❯›]\s+\S/.test(lines[r.line] ?? ""));
  // 質問文はウィジェット行より上にある(先頭行が "❯ ...?" のこともある)
  let question: string | undefined;
  for (let i = rows[0]!.line - 1; i >= 0; i--) {
    const t = strip(lines[i] ?? "");
    if (/[??]$/.test(t)) { question = t.slice(0, 120); break; }
  }
  return {
    question,
    options: rows.map(({ key, label }) => ({ key, label })),
    kind: "form",
    cursorIndex: idx >= 0 ? idx : 0,
  };
}
