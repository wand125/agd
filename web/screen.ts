// 画面テキストと tmux 出力の解析。
//
// ここには外部プロセスや I/O を持ち込まない(server.ts を import すると
// サーバーが起動してしまうため、テストから触れる純粋関数だけを置く)。

export type PromptInfo = {
  question?: string;
  options: { key: string; label: string }[];
  kind?: "numbered" | "cursor";   // cursor: 矢印+Enterで選ぶ形式
  cursorIndex?: number;           // cursor形式での現在選択位置
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
  const lines = plain.split("\n").slice(-18).map(l => l.replace(/[│┃]/g, " ").trimEnd());
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
  // 非番号のカーソル選択(❯ Yes 形式)。空の入力プロンプト(❯ のみ)は除外
  const cursorIdx = lines.findIndex(l => /^\s*[❯›]\s+\S/.test(l) && !optRe.test(l));
  if (cursorIdx >= 0) {
    // カーソル行の上下に連続する「選択肢らしい行」をブロックとして解析
    const isOpt = (l: string | undefined) => {
      const t = (l ?? "").replace(/^\s*[❯›]?\s*/, "").trim();
      return t.length > 0 && t.length <= 80 &&
        !/[??]$/.test(t) &&                       // 質問文
        !/[┌┐└┘─╭╮╰╯═━]/.test(t) &&               // 罫線
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
