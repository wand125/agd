#!/usr/bin/env python3
"""agd iTerm2 キャプチャヘルパー。

iTerm2 Python API で全セッションの画面をセル単位のスタイル付きで取得し、
ANSI エスケープに変換して JSON lines で stdout に流す常駐プロセス。
agd サーバー(Bun)が子プロセスとして起動する。

出力形式:
  {"type": "status", "ok": true/false, "error": "..."}
  {"type": "screens", "screens": {"ttys012": "<ANSI付きテキスト>", ...}}
"""
import asyncio
import json
import sys

import iterm2

POLL_SEC = 2.0


def sgr_for(style) -> list:
    """CellStyle → SGR コード列"""
    codes = []
    if style.bold:
        codes.append("1")
    if style.italic:
        codes.append("3")
    fg = style.WhichOneof("fgColor")
    if fg == "fgStandard":
        n = style.fgStandard
        codes.append(str(30 + n if n < 8 else 90 + n - 8))
    elif fg == "fgRgb":
        c = style.fgRgb
        codes.append(f"38;2;{c.red};{c.green};{c.blue}")
    bg = style.WhichOneof("bgColor")
    if bg == "bgStandard":
        n = style.bgStandard
        codes.append(str(40 + n if n < 8 else 100 + n - 8))
    elif bg == "bgRgb":
        c = style.bgRgb
        codes.append(f"48;2;{c.red};{c.green};{c.blue}")
    return codes


def line_to_ansi(lp) -> str:
    """LineContents proto → ANSI 付きテキスト。

    スタイルはセル単位のラン(repeats)で来るため、code_points_per_cell で
    セル数→文字数の対応を取る(全角文字は2セル1文字などのずれを吸収)。
    """
    text = lp.text.replace("\x00", " ")  # 画像等のプレースホルダセルを空白に
    counts = []
    for run in lp.code_points_per_cell:
        counts.extend([run.num_code_points] * run.repeats)
    out = []
    ci = 0    # 文字インデックス
    cell = 0  # セルインデックス
    for st in lp.style:
        n_cells = st.repeats if st.repeats else 1
        n_chars = sum(counts[cell:cell + n_cells]) if counts else n_cells
        seg = text[ci:ci + n_chars]
        cell += n_cells
        ci += n_chars
        if seg:
            codes = sgr_for(st)
            out.append(f"\x1b[{';'.join(codes)}m{seg}\x1b[0m" if codes else seg)
    if ci < len(text):
        out.append(text[ci:])
    return "".join(out)


async def capture_all(app) -> dict:
    screens = {}
    for w in app.terminal_windows:
        for t in w.tabs:
            for s in t.sessions:
                try:
                    tty = await s.async_get_variable("tty")
                    if not tty:
                        continue
                    contents = await s.async_get_screen_contents()
                    proto = contents._ScreenContents__proto
                    lines = [line_to_ansi(lp) for lp in proto.contents]
                    screens[tty.replace("/dev/", "")] = "\n".join(lines).rstrip()
                except Exception:
                    continue
    return screens


async def main(connection):
    app = await iterm2.async_get_app(connection)
    print(json.dumps({"type": "status", "ok": True}), flush=True)
    while True:
        try:
            await app.async_refresh()
            screens = await capture_all(app)
            print(json.dumps({"type": "screens", "screens": screens}), flush=True)
        except Exception as e:  # 接続断はここで拾って親に伝える
            print(json.dumps({"type": "status", "ok": False, "error": str(e)}), flush=True)
        await asyncio.sleep(POLL_SEC)


if __name__ == "__main__":
    try:
        iterm2.run_forever(main)
    except Exception as e:
        print(json.dumps({"type": "status", "ok": False, "error": str(e)}), flush=True)
        sys.exit(1)
