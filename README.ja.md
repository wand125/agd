# agd — Agent Dashboard

macOS 上で多数の **Claude Code** / **Codex CLI** セッションを並列運用するための、vim スタイル・キーボード駆動のダッシュボードです。

[English README](README.md)

![agd demo](docs/demo.gif)

*(デモは内蔵の `:mask` モードで撮影 — レイアウトと色は実物、テキストはスクランブル済み。[高画質版動画](docs/demo.mp4))*

agd は**既存のセッション**(素の iTerm2 タブや tmux ペインで普通に起動したものを含む)を自動検出し、以下を提供します:

- **ライブ画面グリッド** — 全実行中セッションのターミナル画面をフルカラーで一覧(2.5秒毎更新、ページネーション式でスクロールなし)
- **AI 1行要約** — 各セッションに「何をしていて何を待っているか」のLLM生成ステータスを常時表示。作業完了・入力待ちの瞬間に自動更新(ヘッドレス `claude -p`(haiku)+前回要約と差分だけのローリング方式でコストは僅少。`:sum` で手動更新)
- **ワンタップ応答** — 許可プロンプトを画面から検出してボタン表示。番号型(`❯ 1. Yes`)・カーソル型(`❯ Yes`)、Claude(`❯`)と Codex(`›`)の両方に対応。クリックまたは数字キーで応答
- **ブラウザから指示送信** — カードごとの送信欄。スラッシュコマンドのヒント(claude/codex 出し分け・カスタムコマンド対応)、Shift+Enter で複数行
- **トランスクリプト** — 思考・ツール呼び出しの折りたたみ表示、Edit の diff 整形、サブエージェントのログ、過去への遡り読み込み、全セッション横断の全文検索
- **vim 操作** — `hjkl` でカード移動、`i` で入力、`:q` でセッション終了、`?` で全キーマップ
- **通知** — 入力待ち・完了時に macOS 通知(クリックでターミナルへジャンプ)/ ブラウザ通知
- **セッション管理** — 新規起動(`n` パレット、ディレクトリ補完付き)、複製(`Ctrl+N`)、会話を fork して新セッション化(`Ctrl+C`)、過去セッションの resume、終了(`:q`)
- **スクリーンショットモード** — `:mask` でレイアウトと色を保ったままテキストだけをスクランブル

ラッパープロセス不要 — agd 経由で起動していないセッションもすべて対象になります。

## 動作要件

- macOS + [iTerm2](https://iterm2.com)(iTerm2 内の tmux ペインも対応)
- [Bun](https://bun.sh)
- [Claude Code](https://claude.com/claude-code) / [Codex CLI](https://developers.openai.com/codex/cli)
- オプション:
  - `python3` — iTerm2 Python API ヘルパー(フルカラー画面取得+高速なターミナル操作。無い場合は AppleScript にフォールバック)
  - `terminal-notifier` — クリックでターミナルへジャンプできる macOS 通知
  - `swiftc`(Xcode コマンドラインツール)— ネイティブのデスクトップアプリ shell
  - `fzf` + `jq` — ターミナル版ピッカー(`agd` CLI)用

## インストール

```bash
git clone https://github.com/wand125/agd.git
cd agd
ln -s "$PWD/bin/agd" ~/.local/bin/agd   # PATH の通った場所へ

# 推奨: iTerm2 Python API ヘルパー(カラー取得+高速な focus/入力)
cd web
python3 -m venv .venv
.venv/bin/pip install iterm2
```

ヘルパーを使う場合は iTerm2 側でも API を有効化してください: **Settings → General → Magic → Enable Python API**

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
| `[` / `]` | 前 / 次のページ |
| `g` / `G` | 先頭 / 末尾のカードへ |
| `i` / `Esc` | 入力モード(送信欄へ)/ ノーマルモードへ戻る |
| `Enter` | 確定 — 入力待ちセッションに ⏎ を送信 |
| `1`〜`9` | 検出した許可プロンプトの選択肢に応答 |
| `o` / `f` | トランスクリプト表示 / 実ターミナルへフォーカス |
| `m` / `s` | Shift+Tab(モード切替)/ Esc(中断)を送信 |
| `n` / `Ctrl+N` / `Ctrl+C` | 新規パレット / 複製起動 / 会話を fork して起動 |
| `p`、`⇧HJKL` | セッションをピン留め / カード並び替え(左下上右と交換) |
| `t` / `/` / `:` | タブ切替 / 絞り込み・全文検索 / コマンドライン |

トランスクリプト表示(`o`)の中では `j`/`k` でログエントリを選択、`Enter` で開閉、`:` は表示中のセッションを対象にします。

コマンドライン(`:`): `q` セッション終了 · `sum` 要約更新 · `mask` スクリーンショットモード · `esc`/`mode`/`key <K>` キー送信 · `/<cmd>` スラッシュコマンド転送 · `new` · `show`

## デスクトップアプリ化(macOS)

```bash
bash scripts/install-macapp.sh
```

サーバーを launchd でログイン時自動起動に登録し、`agd.app` を生成します。agd.app は **WKWebView のネイティブシェル**(その場で `swiftc` コンパイル。無い環境では専用プロファイルの Chromium アプリモードにフォールバック)で、ブラウザとは完全に独立 — ブラウザ自動化と干渉せず、Dock クリックは既存ウィンドウへのフォーカスになります。`AGD_PATH_STRIP` / `AGD_PORT` はスクリプト実行時の環境変数で埋め込めます。

導入後のサーバー操作は `launchctl kickstart -k gui/$(id -u)/com.agd.server`(再起動)、ログは `/tmp/agd-server.log`。※ネイティブシェルでは通知は macOS 通知を使ってください(ページ内のブラウザ通知トグルは無効)。

## 設定

| 環境変数 | 効果 |
|---|---|
| `AGD_PORT` | ダッシュボードのポート(デフォルト 8787) |
| `AGD_PATH_STRIP` | UI 上で「…」に短縮する共通パスプレフィックス(例: `~/projects`) |
| `AGD_INDEX_DAYS` | 全文検索インデックスの対象期間・日数(デフォルト 14) |
| `AGD_INDEX_MAX_MB` | 検索DBがこのサイズを超えたら作り直す(デフォルト 300) |

macOS 通知と AI 要約はダッシュボードのヘッダーでオン/オフできます(`~/.cache/agd/config.json` に保存)。

## 仕組み

サーバー(Bun・依存パッケージなし)は、重い処理をすべてメインスレッド外に追い出してイベントループを塞がない構成です。

- **セッション検出** — `claude agents --json`(公式・状態付き)+ `ps`/`lsof` によるプロセス走査を Codex の rollout ファイルと突合。セッションIDが重複する場合もプロセス単位で安定したカードキーを割り当て
- **画面取得** — iTerm2 Python API ヘルパー(セル単位スタイル → ANSI 変換)または `tmux capture-pane -e`。AppleScript フォールバック付き
- **ターミナル操作** — focus・入力・キー・クローズは常駐ヘルパー経由(ミリ秒応答、Apple Events の渋滞なし)。`tmux send-keys` / AppleScript にフォールバック。複数行はブラケットペーストで包んで送信
- **トランスクリプト** — `~/.claude/projects/**.jsonl` と `~/.codex/sessions/**.jsonl` をバイトオフセット管理の増分パース
- **検索・要約** — 専用の Worker スレッドが SQLite FTS5 インデックス(trigram、短い日本語語は LIKE フォールバック)と要約器を担当するため、インデックス構築が UI を止めることはありません

サーバーは `127.0.0.1` のみにバインドします — ターミナルへの入力送信が可能なため、ネットワークに公開しないでください。

## モバイルビュー

`/m` はスマホ向けの別ビューです。PC版の縮小ではなく監視盤として作ってあります。
1行1セッションでAI要約を表示し、入力待ちを最上部に並べ、許可プロンプトには一覧から直接応答できます。
狭い画面でPC版を開くと、上部バナーから移動できます。

## リモートアクセス(tailnet)

サーバーは既定で `127.0.0.1` にバインドし、認証を持ちません。到達できる者はターミナルへ
コマンドを送れるためです。スマホから見る場合は tailnet に載せ、トークンを必須にしてください。

```bash
# 1. トークンを設定して起動(launchd 運用なら plist の環境変数に入れる)
AGD_TOKEN=$(openssl rand -hex 24) agd web

# 2. tailnet 内だけに公開する
tailscale serve --bg --http=8787 http://127.0.0.1:8787
```

`http://<ホスト>.<tailnet>.ts.net:8787/m?token=<トークン>` を一度開けば、以後は Cookie に
保存されます。トークンが無いリクエストは 401 です(localhost からでも同様。`tailscale serve` の
ようなプロキシ経由の外部アクセスも `127.0.0.1` から来るため、ループバックを免除するとトークンが
無意味になります)。`scripts/install-macapp.sh` は `AGD_TOKEN` を読んで `agd.app` に埋め込みます。ホーム画面に追加するとアプリのように使えます。

| 環境変数 | 効果 |
|---|---|
| `AGD_TOKEN` | このトークンを必須にする(`?token=` / Cookie / `Authorization: Bearer`) |
| `AGD_BIND` | バインド先(既定 `127.0.0.1`)。`AGD_TOKEN` 無しで外部に出す指定は起動を拒否する |
| `AGD_READONLY` | 書き込み系APIをすべて拒否し、閲覧専用にする |

## ライセンス

[MIT](LICENSE)
