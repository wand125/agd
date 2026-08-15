import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// 再入防止フラグ("busy")を立てたまま api() の例外で関数を抜けると、フラグが
// 戻らず以後の操作が全て早期 return に吸われる。詳細画面の送信が
// 「一覧からは送れるのに詳細からは無反応」になった原因がこれだった。
// 一覧側は textarea の dataset に持たせていて再描画で要素ごと消えるため
// 自然に復帰していたが、モジュール変数のフラグは永久に立ちっぱなしになる。
describe("再入防止フラグ", () => {
  const dir = join(import.meta.dir, "..", "web", "public");
  const sources = ["app.js", "mobile.js", "core.js"].map(f => [f, readFileSync(join(dir, f), "utf8")] as const);

  test("フラグを立てる箇所には必ず finally での解除がある", () => {
    const offenders: string[] = [];
    for (const [name, src] of sources) {
      const lines = src.split("\n");
      lines.forEach((line, i) => {
        // 「フラグを立てる」代入だけを拾う(宣言時の初期化 let x = false は対象外)
        const set = /^\s*(?:(\w*[Bb]usy)\s*=\s*true|([\w$()."\[\]]+)\.dataset\.busy\s*=)/.exec(line);
        if (!set) return;
        // 同じ関数内(次の閉じ括弧まで)に finally があるか。無ければ例外で詰まる
        const rest = lines.slice(i, i + 40).join("\n");
        if (!/\}\s*finally\s*\{/.test(rest)) {
          offenders.push(`${name}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
