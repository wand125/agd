import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// 別マシン(Neo/iPhone)からダッシュボードを見ているとき、f のジャンプは届かない。
// 母艦の iTerm2 を前面に出すだけで、手元の画面には何も起きないため。
// 代わりに「手元のターミナルに貼れる attach コマンド」を出している。
//
// このコマンドは人が貼って Enter するものなので、壊れていても agd 側では
// 一切エラーにならず、貼った先で初めて失敗する。ここで形を固定しておく。
//
// app.js は素の <script> で読まれる非モジュールなので import できない。
// 純粋関数なのでソースから関数定義だけ抜き出して評価する。
function loadAttachCmd(): (info: Record<string, string>) => string {
  const src = readFileSync(join(import.meta.dir, "..", "web", "public", "app.js"), "utf8");
  const start = src.indexOf("function attachCmd(");
  expect(start).toBeGreaterThan(-1);
  // 関数の終わりは行頭の "}"(この関数はトップレベル定義なのでインデント無し)
  const end = src.indexOf("\n}", start);
  expect(end).toBeGreaterThan(start);
  const body = src.slice(start, end + 2);
  return new Function(`${body}; return attachCmd;`)() as (i: Record<string, string>) => string;
}

describe("attach コマンドの組み立て", () => {
  const attachCmd = loadAttachCmd();

  test("母艦のペインはウィンドウとペインの両方を選んでから attach する", () => {
    const cmd = attachCmd({ host: "m4", tmuxTarget: "work:3.0" });
    // attach だけだと「最後に見ていたウィンドウ」が開いて目的のペインに着かない
    expect(cmd).toContain("select-window -t work:3.0");
    // select-window だけではウィンドウ内の active ペインが変わらない(実測で確認)
    expect(cmd).toContain("select-pane -t work:3.0");
    // attach の対象はセッション名。target をそのまま渡すと attach は受け付けない
    expect(cmd).toContain("attach -t work");
    expect(cmd).not.toContain("attach -t work:3.0");
  });

  test("tmux のコマンド区切りはリモートシェルに \\; として届く", () => {
    // ssh 経由ではシングルクォート内に入るため、素の ";" だとリモートシェルが
    // コマンド区切りとして食べてしまい tmux まで届かない
    const cmd = attachCmd({ host: "m4", tmuxTarget: "work:3.0" });
    expect(cmd).toContain("\\;");
    expect(cmd).not.toMatch(/[^\\];/);
  });

  test("ssh に渡す部分がシングルクォートで閉じている", () => {
    const cmd = attachCmd({ host: "m4", tmuxTarget: "work:3.0" });
    expect((cmd.match(/'/g) ?? []).length % 2).toBe(0);
    expect(cmd.startsWith("ssh m4 -t '")).toBe(true);
    expect(cmd.endsWith("'")).toBe(true);
  });

  test("リモートホストのカードは従来どおりセッション名だけで attach する", () => {
    // こちらは母艦から見た別ホスト。ペイン位置は持たない
    const cmd = attachCmd({ host: "windows-wsl", tmuxSession: "consult" });
    expect(cmd).toBe("ssh windows-wsl -t 'tmux attach -t consult'");
  });

  test("tmux の外で動くセッションは ssh だけを渡す", () => {
    // 空の -t を渡すと貼った先で意味の分からないエラーになる
    const cmd = attachCmd({ host: "m4" });
    expect(cmd).toBe("ssh m4");
    expect(cmd).not.toContain("tmux");
    expect(cmd).not.toContain("-t ''");
  });

  test("ホスト名はブラウザが今見ているものがそのまま入る", () => {
    // Neo からは MagicDNS 名で開いているので、それがそのまま ssh 先になる
    expect(attachCmd({ host: "hiroakimacbook-m4", tmuxTarget: "agd-x1:0.0" }))
      .toContain("ssh hiroakimacbook-m4 ");
  });
});
