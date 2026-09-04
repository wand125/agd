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
  // attachCmd は viewCmd を呼ぶので、両方を取り出して評価する
  const grab = (name: string) => {
    const start = src.indexOf(`function ${name}(`);
    expect(start).toBeGreaterThan(-1);
    // 関数の終わりは行頭の "}"(いずれもトップレベル定義なのでインデント無し)
    const end = src.indexOf("\n}", start);
    expect(end).toBeGreaterThan(start);
    return src.slice(start, end + 2);
  };
  const body = `${grab("viewCmd")}\n${grab("attachCmd")}`;
  return new Function(`${body}; return attachCmd;`)() as (i: Record<string, string>) => string;
}

describe("attach コマンドの組み立て", () => {
  const attachCmd = loadAttachCmd();

  // 素の attach -t <session> は使わない。既に誰かが attach していると
  // tmux は全クライアントで同じウィンドウを共有するため、新しく開いたつもりが
  // 既存ウィンドウと同じ画面になり、しかも select-window が元のクライアントの
  // 表示まで切り替えてしまう(「開かない・別のチャットが出る」として実際に踏んだ)
  test("専用ビューを作ってから目的のウィンドウを選ぶ", () => {
    const cmd = attachCmd({ host: "m4", tmuxTarget: "work:3.0" });
    // -t でグループ化した別セッションを作る。-A で既存があれば繋ぎ直す
    expect(cmd).toContain("new-session -A -t work -s work-view");
    // ウィンドウ選択はビュー側に対して行う(元のクライアントを動かさない)
    expect(cmd).toContain("select-window -t work-view:3");
    // ペインはウィンドウ内の位置なので元の target のまま
    expect(cmd).toContain("select-pane -t work:3.0");
  });

  test("既存クライアントを奪う attach -t <session> を使わない", () => {
    const cmd = attachCmd({ host: "m4", tmuxTarget: "work:3.0" });
    expect(cmd).not.toMatch(/attach -t work(?!-view)/);
  });

  test("select-window にはウィンドウ番号だけを渡す", () => {
    // "3.0" でも tmux は通すが、ウィンドウ指定にペイン番号が混ざるのは紛らわしい
    const cmd = attachCmd({ host: "m4", tmuxTarget: "work:3.0" });
    expect(cmd).not.toContain("select-window -t work-view:3.0");
  });

  test("tmux は絶対パスで呼ぶ(非対話 ssh は PATH が細い)", () => {
    // ssh の非対話実行は /etc/zprofile を読まず PATH が /usr/bin:/bin:/usr/sbin:/sbin
    // だけになる。素の "tmux" だと command not found で終わる(Neo で実測)
    const cmd = attachCmd({ host: "m4", tmuxTarget: "work:3.0", tmuxBin: "/opt/homebrew/bin/tmux" });
    expect(cmd).toContain("'/opt/homebrew/bin/tmux new-session");
    expect(cmd).not.toContain("'tmux new-session");
  });

  test("tmux の場所が分からなければ素の tmux に落とす", () => {
    // PATH が通っている環境なら動く。undefined を埋め込むよりまし
    expect(attachCmd({ host: "m4", tmuxTarget: "work:3.0" })).toContain("'tmux new-session");
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
    expect(attachCmd({ host: "hiroakimacbook-m4", tmuxTarget: "agd-x1:0.0" }))
      .toContain("ssh hiroakimacbook-m4 ");
  });
});

// Neo は ssh のポートフォワード(-L 8787:localhost:8787)経由で開くため、
// location.hostname は localhost になり母艦のブラウザと区別が付かない。
// そのまま ssh 先にすると「自分自身に ssh する」コマンドを渡してしまう。
describe("ssh 先ホストの決定", () => {
  const src = readFileSync(join(import.meta.dir, "..", "web", "public", "app.js"), "utf8");
  const start = src.indexOf("function sshHost(");
  const body = src.slice(start, src.indexOf("\n}", start) + 2);
  const make = (hostname: string, served: string) =>
    new Function("location", "window", `${body}; return sshHost();`)(
      { hostname }, { agdSshHost: served });

  test("ポートフォワード越し(localhost)ならサーバーが教えた名前を使う", () => {
    // サーバーは user@host 形式で返す。手元(Neo=hiroaki)と母艦(HHosono)で
    // ユーザー名が違い、名前だけだと Permission denied になる(実際に踏んだ)
    for (const h of ["localhost", "127.0.0.1", "::1"])
      expect(make(h, "HHosono@hiroakimacbook-m4")).toBe("HHosono@hiroakimacbook-m4");
  });

  test("直接ホスト名で開いているならそれを尊重する", () => {
    // tailscale serve や LAN 越しに素で開いている場合。サーバーの申告より
    // 実際に届いている名前の方が確実
    expect(make("hiroakimacbook-m4", "somethingelse")).toBe("hiroakimacbook-m4");
    expect(make("192.168.11.8", "somethingelse")).toBe("192.168.11.8");
  });

  test("サーバーが名前を返さないときは空を返す(ループバックを渡さない)", () => {
    // ループバックのまま渡すと、手元のマシンが自分自身に ssh してしまう。
    // 実際に Neo で踏んだ: Neo 自身の tmux に繋がり "no current target" で終わった。
    // 呼び出し側はこの空を見てコマンドではなく理由を出す
    for (const h of ["localhost", "127.0.0.1", "::1"]) expect(make(h, "")).toBe("");
  });
});

// attach 用に作る <session>-view も tmux 上は独立したセッションなので、
// そのまま target にすると view にさらに view を作る案内になり、
// -view-view-view と伸びていく(実際に生成されたものを確認した)
describe("view セッションの二重生成", () => {
  const attachCmd = loadAttachCmd();

  test("target が既に -view でも view を重ねない", () => {
    const cmd = attachCmd({ host: "m4", tmuxTarget: "work-view:3.0" });
    expect(cmd).toContain("-t work -s work-view");
    expect(cmd).not.toContain("work-view-view");
  });

  test("-view が複数付いていても剥がす", () => {
    const cmd = attachCmd({ host: "m4", tmuxTarget: "work-view-view:3.0" });
    expect(cmd).toContain("-t work -s work-view");
    expect(cmd).not.toContain("work-view-view");
  });

  // 名前の途中に view を含むセッションまで削ってはいけない
  test("末尾以外の view は残す", () => {
    const cmd = attachCmd({ host: "m4", tmuxTarget: "viewer:1.0" });
    expect(cmd).toContain("-t viewer -s viewer-view");
  });
});

// status=waiting でも画面に選択肢が出ているとは限らない。claude agents は
// 「入力待ち」を独自に報告するため、キューに未処理のメッセージがあるだけでも
// waiting になる。選択肢が無いのに応答ボタンを並べると、待っていない画面に
// プロンプトが出ているように見える。
describe("プロンプトバーの表示条件", () => {
  const src = readFileSync(join(import.meta.dir, "..", "web", "public", "app.js"), "utf8");
  const start = src.indexOf("function renderPromptBar(");
  const body = src.slice(start, src.indexOf("\n}", start) + 2);

  test("選択肢の有無を条件に含める", () => {
    // status だけで判定していると、選択肢ゼロでも汎用ボタンが並ぶ
    expect(body).toContain("s.prompt?.options?.length");
    // 早期 return の条件に含まれていること(canOperate(s) を挟むので行で見る)
    const guard = body.split("\n").find(l => l.includes('s.status !== "waiting"')) ?? "";
    expect(guard).toContain("!hasOpts");
  });

  test("条件を満たさなければ隠す", () => {
    expect(body).toContain('bar.style.display = "none"');
  });
});
