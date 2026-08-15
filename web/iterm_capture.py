#!/usr/bin/env python3
"""agd iTerm2 ヘルパー。

役割1(画面取得): 全セッションの画面をセル単位スタイル付きで取得し、
ANSI に変換して JSON lines で stdout に流す(2秒周期)。
役割2(操作): stdin から JSON lines でコマンドを受け、iTerm2 Python API で実行する。
  {"id": 1, "op": "focus"|"send"|"key"|"close", "tty": "ttys012", ...}
osascript(Apple Events)と違い常駐接続なので ms 級で応答し、キュー渋滞も起きない。

出力形式:
  {"type": "status", "ok": true/false, "error": "..."}
  {"type": "screens", "screens": {"ttys012": "<ANSI付きテキスト>", ...}}
  {"type": "op", "id": 1, "ok": true/false, "error": "..."}
"""
import asyncio
import json
import os
import sys

import iterm2

POLL_SEC = 2.0

KEYMAP = {
    "Enter": "\r",
    "Escape": "\x1b",
    "Up": "\x1b[A",
    "Down": "\x1b[B",
    "Right": "\x1b[C",
    "Left": "\x1b[D",
    "Tab": "\t",
    "ShiftTab": "\x1b[Z",
    "Space": " ",
}


def sgr_for(style) -> list:
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
    text = lp.text.replace("\x00", " ")  # 画像等のプレースホルダセルを空白に
    counts = []
    for run in lp.code_points_per_cell:
        counts.extend([run.num_code_points] * run.repeats)
    out = []
    ci = 0
    cell = 0
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


async def find_session(app, tty: str):
    target = "/dev/" + tty
    for w in app.terminal_windows:
        for t in w.tabs:
            for s in t.sessions:
                try:
                    if await s.async_get_variable("tty") == target:
                        return s
                except Exception:
                    continue
    return None


async def handle_op(app, msg) -> dict:
    op = msg.get("op")
    oid = msg.get("id")
    try:
        await app.async_refresh()
        session = await find_session(app, msg.get("tty", ""))
        if session is None:
            return {"type": "op", "id": oid, "ok": False, "error": "session not found"}
        if op == "focus":
            await session.async_activate(select_tab=True, order_window_front=True)
            await app.async_activate()
        elif op == "send":
            text = msg.get("text", "")
            # 複数行はブラケットペーストで包む。テキストと Enter は分離して送る
            payload = f"\x1b[200~{text}\x1b[201~" if "\n" in text else text
            await session.async_send_text(payload)
            await asyncio.sleep(0.15)
            await session.async_send_text("\r")
        elif op == "key":
            for k in msg.get("keys", []):
                await session.async_send_text(KEYMAP.get(k, k))
                await asyncio.sleep(0.12)
        elif op == "close":
            await session.async_close(force=True)
        else:
            return {"type": "op", "id": oid, "ok": False, "error": f"unknown op: {op}"}
        return {"type": "op", "id": oid, "ok": True}
    except Exception as e:
        return {"type": "op", "id": oid, "ok": False, "error": str(e)}


# 遡って取り込む行数(サーバー側の AGD_SCROLLBACK と揃える)
SCROLLBACK = int(os.environ.get("AGD_SCROLLBACK", "200"))


async def capture_all(app) -> dict:
    screens = {}
    for w in app.terminal_windows:
        for t in w.tabs:
            for s in t.sessions:
                try:
                    tty = await s.async_get_variable("tty")
                    if not tty:
                        continue
                    # 表示中の画面に加えてスクロールバックも取り込む。
                    # カード内を上にスクロールして過去の出力を追えるようにする。
                    # 古い API では range 指定が使えないので、その場合は現在画面のみ。
                    lines = []
                    try:
                        info = await s.async_get_line_info()
                        # 画面 + スクロールバックのうち、末尾 SCROLLBACK 行を取る
                        have = info.scrollback_buffer_height + info.mutable_area_height
                        want = min(SCROLLBACK, have)
                        first = info.overflow + have - want
                        lines = [line_to_ansi(lc._LineContents__proto)
                                 for lc in await s.async_get_contents(first, want)]
                    except Exception:
                        # 古い API では range 取得ができない。現在の画面だけ返す
                        contents = await s.async_get_screen_contents()
                        lines = [line_to_ansi(lp) for lp in contents._ScreenContents__proto.contents]
                    screens[tty.replace("/dev/", "")] = "\n".join(lines).rstrip()
                except Exception:
                    continue
    return screens


async def stdin_loop(app):
    loop = asyncio.get_event_loop()
    reader = asyncio.StreamReader()
    protocol = asyncio.StreamReaderProtocol(reader)
    await loop.connect_read_pipe(lambda: protocol, sys.stdin)
    while True:
        line = await reader.readline()
        if not line:
            break
        try:
            msg = json.loads(line)
        except Exception:
            continue
        result = await handle_op(app, msg)
        print(json.dumps(result), flush=True)


async def capture_loop(app):
    while True:
        try:
            await app.async_refresh()
            screens = await capture_all(app)
            print(json.dumps({"type": "screens", "screens": screens}), flush=True)
        except Exception as e:
            print(json.dumps({"type": "status", "ok": False, "error": str(e)}), flush=True)
        await asyncio.sleep(POLL_SEC)


async def main(connection):
    app = await iterm2.async_get_app(connection)
    print(json.dumps({"type": "status", "ok": True}), flush=True)
    await asyncio.gather(capture_loop(app), stdin_loop(app))


if __name__ == "__main__":
    try:
        iterm2.run_forever(main)
    except Exception as e:
        print(json.dumps({"type": "status", "ok": False, "error": str(e)}), flush=True)
        sys.exit(1)
