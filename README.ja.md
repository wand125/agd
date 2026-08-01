# agd — Agent Dashboard

macOS 上で多数の **Claude Code** / **Codex CLI** セッションを並列運用するための、vim スタイル・キーボード駆動のダッシュボードです。

[English README](README.md)

![agd demo](docs/demo.gif)

*(デモは内蔵の `:mask` モードで撮影 — レイアウトと色は実物、テキストはスクランブル済み。[高画質版動画](docs/demo.mp4))*

agd は**既存のセッション**(素の iTerm2 タブや tmux ペインで普通に起動したものを含む)を自動検出し、以下を提供します:

- **ライブ画面グリッド** — 全実行中セッションのターミナル画面をフルカラーで一覧(2.5秒毎更新、ページネーション式でスクロールなし)
- **ワンタップ応答** — 許可プロンプト(`❯ 1. Yes` 形式・カーソル選択形式)を画面から検出してボタン表示。クリックまたは数字キーで応答
- **ブラウザから指示送信** — カードごとの送信欄。スラッシュコマンドのヒント(claude/codex 出し分け・カスタムコマンド対応)、Shift+Enter で複数行
- **トランスクリプト** — 思考・ツール呼び出しの折りたたみ表示、Edit の diff 整形、サブエージェントのログ、増分読み込み、横断検索
- **vim 操作** — `hjkl` でカード移動、`i` で入力、`:q` でセッション終了、`?` で全キーマップ
- **通知** — 入力待ち・完了時にブラウザ通知 / macOS 通知
- **セッション管理** — 新規起動(`n` パレット、ディレクトリ補完付き)、複製(`Ctrl+N`)、会話引き継ぎ(`Ctrl+C`)、過去セッションの resume、終了(`:q`)

ラッパープロセス不要 — agd 経由で起動していないセッションもすべて対象になります。

## 動作要件

- macOS + [iTerm2](https://iterm2.com)(iTerm2 内の tmux ペインも対応)
- [Bun](https://bun.sh)
- [Claude Code](https://claude.com/claude-code) / [Codex CLI](https://developers.openai.com/codex/cli)
- オプション:
  - `python3` — iTerm2 Python API によるフルカラー画面取得(無い場合はモノクロの AppleScript にフォールバック)
  - `fzf` + `jq` — ターミナル版ピッカー(`agd` CLI)用
  - `terminal-notifier` — クリックでターミナルへジャンプできる macOS 通知

## インストール

```bash
git clone https://github.com/wand125/agd.git
cd agd
ln -s "$PWD/bin/agd" ~/.local/bin/agd   # PATH の通った場所へ

# オプション: フルカラー画面取得(iTerm2 Python API)
cd web
python3 -m venv .venv
.venv/bin/pip install iterm2
```

カラー取得を使う場合は iTerm2 側でも API を有効化してください: **Settings → General → Magic → Enable Python API**

## 使い方

```bash
agd web      # ブラウザダッシュボード → http://localhost:8787
agd          # fzf ピッカー(ターミナルからジャンプ / resume)
agd list     # セッション一覧のテーブル表示
agd watch    # 自動更新表示
```

### キーバインド(ダッシュボード)

ダッシュボード上で `?` を押すと全一覧が出ます。主要なもの:

| キー | 動作 |
|---|---|
| `h j k l` | カード移動(左右端でページ跨ぎ) |
| `i` / `Esc` | 入力モード(送信欄へ)/ ノーマルモードへ戻る |
| `Enter` | 確定 — 入力待ちセッションに ⏎ を送信 |
| `1`〜`9` | 検出した許可プロンプトの選択肢に応答 |
| `o` / `f` | トランスクリプト表示 / 実ターミナルへフォーカス |
| `m` / `s` | Shift+Tab(モード切替)/ Esc(中断)を送信 |
| `n` / `Ctrl+N` / `Ctrl+C` | 新規パレット / 複製起動 / 会話を引き継いで起動 |
| `p`、`⇧H`/`⇧L` | セッションをピン留め / カード並び替え |
| `t` / `/` / `:` | タブ切替 / 絞り込み・ログ検索 / コマンドライン(`:q`、`:/clear` など) |

## 設定

| 環境変数 | 効果 |
|---|---|
| `AGD_PORT` | ダッシュボードのポート(デフォルト 8787) |
| `AGD_PATH_STRIP` | UI 上で「…」に短縮する共通パスプレフィックス(例: `~/projects`) |
| `AGD_INDEX_DAYS` | 全文検索インデックスの対象期間・日数(デフォルト 30) |

macOS 通知はダッシュボードのヘッダーでオン/オフできます(`~/.cache/agd/config.json` に保存)。

## 仕組み

- **セッション検出**: `claude agents --json`(公式・状態付き)+ `ps`/`lsof` によるプロセス走査を Codex の rollout ファイルと突合
- **画面取得**: iTerm2 Python API(セル単位スタイル → ANSI 変換)または `tmux capture-pane -e`。AppleScript フォールバック付き
- **入力・キー送信**: `tmux send-keys` / iTerm2 AppleScript `write text`。複数行はブラケットペーストで包んで送信
- **トランスクリプト**: `~/.claude/projects/**.jsonl` と `~/.codex/sessions/**.jsonl` をバイトオフセット管理の増分パース

サーバーは `127.0.0.1` のみにバインドします — ターミナルへの入力送信が可能なため、ネットワークに公開しないでください。

## ライセンス

[MIT](LICENSE)
