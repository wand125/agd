// UI 文言の多言語化。app.js より先に読み込まれ、グローバルに t() を提供する。
//
// 使い方:
//   t("card.pin")            → 現在の言語の文言
//   t("toast.pinned", {name}) → {name} を置換
//
// 言語の決定順: localStorage("agd-lang") → navigator.language → "en"
// 切替は setLang("ja"|"en") / コマンドライン `:lang en` / ヘッダーの選択。

const STRINGS = {
  en: {
    // ---- header ----
    "tab.grid": "Screens",
    "tab.list": "Sessions",
    "search.placeholder": "Filter / Enter for full-text search",
    "sort.stable": "Fixed",
    "sort.status": "By status",
    "sort.title": "Sort order",
    "perpage.title": "Cards per page",
    "page.prev": "Previous page",
    "page.next": "Next page",
    "btn.new": "+ New",
    "toggle.notify": "Notify",
    "toggle.macnotify": "macOS",
    "kbd.help": "<kbd>hjkl</kbd>move <kbd>i</kbd>input <kbd>o</kbd>detail <kbd>f</kbd>jump <kbd>?</kbd>help",
    "filter.waiting": "waiting",
    "filter.busy": "busy",
    "filter.idle": "idle",

    // ---- grid / list ----
    "grid.empty": "No sessions found",
    "list.running": "Running",
    "list.resumable": "Resumable sessions",
    "row.log": "Log",
    "row.resume": "resume",
    "stats.disconnected": "Disconnected — reconnecting…",
    "stats.counts": "▲ {waiting} · ● {busy} · ○ {idle}",

    // ---- card buttons ----
    "card.moveLeft": "Move card left (⇧H)",
    "card.moveUp": "Move card up (⇧K)",
    "card.moveDown": "Move card down (⇧J)",
    "card.moveRight": "Move card right (⇧L)",
    "card.pin": "Pin (keep this session first)",
    "card.detail": "Open detailed log",
    "card.jump": "Jump to terminal",
    "card.latest": "↓ Latest",
    "card.sendPlaceholder": "⏎ send / ⇧⏎ newline",
    "card.screenUnavailable": "(screen unavailable)",

    // ---- detail ----
    "detail.jump": "⌖ Jump",
    "detail.subagent": "Show subagent log",
    "detail.inputPlaceholder": "Send to this session… (⏎ send / ⇧⏎ newline / Esc to scroll mode)",
    "detail.loadOlder": "Load older entries",
    "detail.screenUnavailable": "(no screen available because this session is not running)",
    "detail.main": "Main",
    "detail.loadOlderCount": "▲ Load more ({n} remaining)",
    "detail.thinking": "💭 Thinking",
    "detail.result": "📄 Result",
    "detail.showFull": "…Show full text ({limit})",
    "detail.truncateLabel": "truncated at 4,000 characters",

    // ---- search ----
    "search.title": "🔎 Search across logs: ",
    "search.searching": "Searching…",
    "search.noHits": "No matches",
    "search.hits": "{n} matches",
    "search.indexing": "⏳ Building full-text index ({done}/{total}) — showing basic search results until complete",

    // ---- new session palette ----
    "new.title": "New session",
    "new.agentSwitch": "Tab to switch",
    "new.hint": "<kbd>j/k</kbd>select <kbd>i</kbd>filter <kbd>Tab</kbd>switch <kbd>⏎</kbd>launch <kbd>q</kbd>close",
    "new.placeholder": "Search a project, or type an absolute path",
    "new.createDir": "Directory does not exist. Press ⏎ again to create it.",
    "new.createDirLaunch": "📁 Create directory and launch: {path}",

    // ---- toasts ----
    "toast.pinned": "📌 Pinned: {name}",
    "toast.unpinned": "📌 Unpinned: {name}",
    "toast.noCardSelected": "No card selected",
    "toast.atStart": "Already at the start",
    "toast.atEnd": "Already at the end",
    "toast.movedTo": "📌 Moved {dir}",
    "toast.cardMovedTo": "↔ Card moved {dir}",
    "toast.pinBoundary": "📌 Pin boundary (press p to match pin state to cross it)",
    "toast.selectionMoved": "Selection moved to the new session",
    "toast.maskOn": "🎭 Mask mode ON (:mask to turn off)",
    "toast.maskOff": "Mask mode OFF",
    "toast.selectRunning": "Select a running session",
    "toast.sendFailed": "Send failed: {err}",
    "toast.langChanged": "Language: English",
    "toast.currentLang": "Current language: {lang}",
    "toast.sentTo": "{action} → {name}",
    "toast.qNoSession": ":q — No session selected",
    "toast.ttyCloseUnknown": "Cannot close: tty is unknown",
    "toast.closed": "✕ Closed {name}",
    "toast.closeFailed": "Close failed: {err}",
    "toast.hidden": "Hidden {name} from the list (:show to restore all)",
    "toast.shown": "Restored hidden sessions",
    "toast.sumNoSession": ":sum — No session selected",
    "toast.summarizing": "Generating summary… (updates in a few seconds)",
    "toast.invalidKey": "Unknown key: {key} (available: {valid})",
    "toast.unknownCommand": "Unsupported command: :{cmd} (available: q / show / new / mask / esc / mode / key <K> / lang <en|ja> / /<cmd>)",
    "toast.resumed": "▶ Resumed {agent} session in a new tab",
    "toast.sent": "Sent",
    "toast.optionConfirmed": "Confirmed option {n}",
    "toast.numberSent": "Sent “{n}”",
    "toast.notWaiting": "Not waiting for input; ⏎ was not sent",
    "toast.enterSent": "Sent ⏎ (confirm)",
    "toast.ttyJumpUnknown": "Cannot jump: tty is unknown",
    "toast.ttySendUnknown": "Cannot send: tty is unknown",
    "toast.detailNotRunning": "Cannot send to a session that is not running (resume it first)",
    "toast.launchFailed": "Launch failed: {err}",
    "toast.launched": "▶ Launched {agent} in {project}",
    "toast.noResumable": "No session is available to continue",
    "toast.forked": "⎘ Continued the {agent} conversation in a new tab",

    // ---- actions / prompts / hints ----
    "action.interrupt": "Esc (interrupt)",
    "action.mode": "⇧Tab (switch mode)",
    "prompt.confirm": "⏎ Confirm",
    "hint.detailScroll": "<kbd>j/k</kbd>select <kbd>d/u</kbd>±5 <kbd>⏎</kbd>toggle <kbd>1-9</kbd>answer <kbd>i</kbd>input <kbd>s</kbd>interrupt <kbd>^N</kbd>duplicate <kbd>^C</kbd>fork <kbd>:</kbd>cmd <kbd>q</kbd>close",
    "hint.detailInsert": "<kbd>⏎</kbd>send <kbd>⇧⏎</kbd>newline <kbd>Esc</kbd>scroll mode",

    // ---- directions ----
    "dir.up": "up",
    "dir.down": "down",
    "dir.prev": "left",
    "dir.next": "right",

    // ---- status ----
    "status.waiting": "waiting",
    "status.busy": "busy",
    "status.idle": "idle",
    "status.resumable": "resumable",
    "notify.waiting": "needs input",
    "notify.done": "done",

    // ---- command line ----
    "cmd.q": "Close selected session (running) / hide (history)",
    "cmd.show": "Show all hidden history again",
    "cmd.new": "Open the new-session palette",
    "cmd.esc": "Send Esc (interrupt) to the selected session",
    "cmd.mode": "Send ⇧Tab (permission mode) to the selected session",
    "cmd.key": "Send any key (Up/Down/Left/Right/Tab/ShiftTab/Enter/Escape)",
    "cmd.mask": "Toggle mask mode (scramble content for screenshots)",
    "cmd.sum": "Refresh the one-line summary of the selected session now",
    "cmd.slash": "Send a slash command to the selected session",
    "cmd.lang": "Switch UI language (:lang en / :lang ja)",

    // ---- help ----
    "help.title": "Keyboard shortcuts",
    "help.close": "<kbd>?</kbd> or <kbd>Esc</kbd> to close",
    "help.h.move": "Move & select (normal mode)",
    "help.h.session": "Session actions",
    "help.h.lifecycle": "Launch & close",
    "help.h.organize": "Organize & search",
    "help.h.input": "Input box & palette",
    "help.h.detail": "Detail view (o)",
    "help.move.hjkl": "Move between cards (crosses pages at the edges)",
    "help.move.gG": "First / last card (in detail view: first/last log entry)",
    "help.move.pages": "Next page / previous page",
    "help.move.tab": "Switch Screens ⇄ Sessions tab",
    "help.move.esc": "Insert mode → normal mode (selection kept)",
    "help.sess.i": "Insert mode (focus send box). In the list: detail/resume",
    "help.sess.enter": "Confirm — send ⏎ to a session waiting for input",
    "help.sess.digits": "Answer a permission prompt (numbered and cursor style)",
    "help.sess.o": "Detail popup (log + send)",
    "help.sess.f": "Jump to (focus) the terminal",
    "help.sess.m": "Send ⇧Tab (cycle permission mode)",
    "help.sess.s": "Send Esc (interrupt current work)",
    "help.life.n": "New session palette",
    "help.life.ctrln": "Duplicate (same project and agent)",
    "help.life.ctrlc": "Fork the conversation into a new tab (resume)",
    "help.life.q": "Close the selected session / hide from history",
    "help.org.p": "Pin (keep this session first)",
    "help.org.move": "Reorder card left / down / up / right (swap positions)",
    "help.org.slash": "Filter (Enter for full-text search across logs)",
    "help.org.colon": "Command line (q / show / new / mask / esc / mode / key / /command)",
    "help.org.mask": "Mask mode — scramble all text for screenshots",
    "help.in.slash": "Type / in the send box for slash-command hints",
    "help.in.tab": "Complete a hint / switch agent in the palette",
    "help.in.enter": "Send ⏎ (confirm) to a session waiting for input",
    "help.in.shiftenter": "Newline in the send box (it grows upward)",
    "help.det.jk": "Select a log entry (one / ±5 / first & last)",
    "help.det.fold": "Toggle / open / close the selected entry",
    "help.det.modes": "Focus send box / selection mode / close",
    "help.det.ops": "Interrupt (Esc) / permission mode / command line (:q closes the viewed session)",
    "help.det.dup": "Duplicate / fork the viewed session (works while typing in the send box)",
    "help.emptyEnter": "<kbd>Enter</kbd> when empty",
  },

  ja: {
    // ---- header ----
    "tab.grid": "画面一覧",
    "tab.list": "セッション",
    "search.placeholder": "絞り込み / Enterで全文検索",
    "sort.stable": "固定順",
    "sort.status": "状態順",
    "sort.title": "並び順",
    "perpage.title": "1ページの表示数",
    "page.prev": "前のページ",
    "page.next": "次のページ",
    "btn.new": "+ 新規",
    "toggle.notify": "通知",
    "toggle.macnotify": "macOS",
    "kbd.help": "<kbd>hjkl</kbd>移動 <kbd>i</kbd>入力 <kbd>o</kbd>詳細 <kbd>f</kbd>跳 <kbd>?</kbd>ヘルプ",
    "filter.waiting": "入力待ち",
    "filter.busy": "実行中",
    "filter.idle": "待機",

    // ---- grid / list ----
    "grid.empty": "セッションが見つかりません",
    "list.running": "実行中",
    "list.resumable": "resume 可能なセッション",
    "row.log": "ログ",
    "row.resume": "resume",
    "stats.disconnected": "切断 — 再接続中…",
    "stats.counts": "▲ {waiting} · ● {busy} · ○ {idle}",

    // ---- card buttons ----
    "card.moveLeft": "カードを前へ (⇧H)",
    "card.moveUp": "カードを上へ (⇧K)",
    "card.moveDown": "カードを下へ (⇧J)",
    "card.moveRight": "カードを後ろへ (⇧L)",
    "card.pin": "ピン留め(このセッションを先頭に固定)",
    "card.detail": "詳細ログを開く",
    "card.jump": "ターミナルへジャンプ",
    "card.latest": "↓ 最新",
    "card.sendPlaceholder": "⏎送信 / ⇧⏎改行",
    "card.screenUnavailable": "(画面を取得できません)",

    // ---- detail ----
    "detail.jump": "⌖ ジャンプ",
    "detail.subagent": "サブエージェントのログを表示",
    "detail.inputPlaceholder": "このセッションに送信…(⏎送信 / ⇧⏎改行 / Escでスクロールモード)",
    "detail.loadOlder": "以前のログを読み込む",
    "detail.screenUnavailable": "(実行中でないため画面はありません)",
    "detail.main": "本体",
    "detail.loadOlderCount": "▲ さらに読み込む(残り {n} 件)",
    "detail.thinking": "💭 思考",
    "detail.result": "📄 結果",
    "detail.showFull": "…全文を表示({limit})",
    "detail.truncateLabel": "4000字で省略中",

    // ---- search ----
    "search.title": "🔎 ログ横断検索: ",
    "search.searching": "検索中…",
    "search.noHits": "一致なし",
    "search.hits": "{n} 件",
    "search.indexing": "⏳ 全文インデックス構築中 ({done}/{total}) — 完了までは簡易検索の結果です",

    // ---- new session palette ----
    "new.title": "新規セッション",
    "new.agentSwitch": "Tabで切替",
    "new.hint": "<kbd>j/k</kbd>選択 <kbd>i</kbd>絞込 <kbd>Tab</kbd>切替 <kbd>⏎</kbd>起動 <kbd>q</kbd>閉",
    "new.placeholder": "プロジェクトを検索、または絶対パスを入力",
    "new.createDir": "ディレクトリが存在しません。もう一度 ⏎ で作成します。",
    "new.createDirLaunch": "📁 ディレクトリを作成して起動: {path}",

    // ---- toasts ----
    "toast.pinned": "📌 ピン留め: {name}",
    "toast.unpinned": "📌 解除: {name}",
    "toast.noCardSelected": "カードが選択されていません",
    "toast.atStart": "すでに先頭側です",
    "toast.atEnd": "すでに末尾側です",
    "toast.movedTo": "📌 {dir}へ",
    "toast.cardMovedTo": "↔ カードを{dir}へ",
    "toast.pinBoundary": "📌 ピン領域の境界です(p でピン状態を揃えると跨げます)",
    "toast.selectionMoved": "新しいセッションに選択を移しました",
    "toast.maskOn": "🎭 マスクモード ON(:mask で解除)",
    "toast.maskOff": "マスクモード OFF",
    "toast.selectRunning": "実行中のセッションを選択してください",
    "toast.sendFailed": "送信失敗: {err}",
    "toast.langChanged": "表示言語: 日本語",
    "toast.currentLang": "現在の表示言語: {lang}",
    "toast.sentTo": "{action} → {name}",
    "toast.qNoSession": ":q — セッションが選択されていません",
    "toast.ttyCloseUnknown": "tty不明のため終了できません",
    "toast.closed": "✕ {name} を終了しました",
    "toast.closeFailed": "終了失敗: {err}",
    "toast.hidden": "{name} を一覧から非表示にしました(:show で全再表示)",
    "toast.shown": "非表示にしたセッションを再表示しました",
    "toast.sumNoSession": ":sum — セッションが選択されていません",
    "toast.summarizing": "要約を実行中…(数秒後に反映)",
    "toast.invalidKey": "不明なキー: {key}(使用可: {valid})",
    "toast.unknownCommand": "未対応コマンド: :{cmd}(使用可: q / show / new / mask / esc / mode / key <K> / lang <en|ja> / /<cmd>)",
    "toast.resumed": "▶ {agent} セッションを新しいタブで resume しました",
    "toast.sent": "送信しました",
    "toast.optionConfirmed": "選択肢 {n} を確定しました",
    "toast.numberSent": "「{n}」を送信しました",
    "toast.notWaiting": "入力待ちではないため ⏎ は送信しません",
    "toast.enterSent": "⏎ を送信しました(確定)",
    "toast.ttyJumpUnknown": "ttyが不明のためジャンプできません",
    "toast.ttySendUnknown": "ttyが不明のため送信できません",
    "toast.detailNotRunning": "実行中でないセッションには送信できません(resumeしてください)",
    "toast.launchFailed": "起動失敗: {err}",
    "toast.launched": "▶ {agent} を {project} で起動しました",
    "toast.noResumable": "引き継げるセッションがありません",
    "toast.forked": "⎘ {agent} の会話を引き継いで新タブで起動しました",

    // ---- actions / prompts / hints ----
    "action.interrupt": "Esc(中断)",
    "action.mode": "⇧Tab(モード切替)",
    "prompt.confirm": "⏎ 確定",
    "hint.detailScroll": "<kbd>j/k</kbd>選択 <kbd>d/u</kbd>±5 <kbd>⏎</kbd>開閉 <kbd>1-9</kbd>応答 <kbd>i</kbd>入力 <kbd>s</kbd>中断 <kbd>^N</kbd>複製 <kbd>^C</kbd>引継 <kbd>:</kbd>cmd <kbd>q</kbd>閉じる",
    "hint.detailInsert": "<kbd>⏎</kbd>送信 <kbd>⇧⏎</kbd>改行 <kbd>Esc</kbd>スクロールモードへ",

    // ---- directions ----
    "dir.up": "上",
    "dir.down": "下",
    "dir.prev": "前",
    "dir.next": "後ろ",

    // ---- status ----
    "status.waiting": "入力待ち",
    "status.busy": "実行中",
    "status.idle": "待機",
    "status.resumable": "resumable",
    "notify.waiting": "入力待ち",
    "notify.done": "完了",

    // ---- command line ----
    "cmd.q": "選択セッションを終了(実行中)/ 非表示(履歴)",
    "cmd.show": "非表示にした履歴を全て再表示",
    "cmd.new": "新規セッションパレットを開く",
    "cmd.esc": "選択セッションに Esc(中断)を送信",
    "cmd.mode": "選択セッションに ⇧Tab(モード切替)を送信",
    "cmd.key": "任意キー送信 (Up/Down/Left/Right/Tab/ShiftTab/Enter/Escape)",
    "cmd.mask": "マスクモード切替(スクリーンショット用に内容をスクランブル)",
    "cmd.sum": "選択セッションの1行要約を今すぐ更新",
    "cmd.slash": "スラッシュコマンドを選択セッションへ送信",
    "cmd.lang": "表示言語を切替(:lang en / :lang ja)",

    // ---- help ----
    "help.title": "キーボードショートカット",
    "help.close": "<kbd>?</kbd> または <kbd>Esc</kbd> で閉じる",
    "help.h.move": "移動・選択(ノーマルモード)",
    "help.h.session": "セッション操作",
    "help.h.lifecycle": "起動・終了",
    "help.h.organize": "整理・検索",
    "help.h.input": "入力欄・パレット内",
    "help.h.detail": "詳細画面(o)",
    "help.move.hjkl": "カード移動(左右端でページ跨ぎ)",
    "help.move.gG": "先頭 / 末尾のカードへ(詳細画面ではログの先頭/末尾)",
    "help.move.pages": "次ページ / 前ページ",
    "help.move.tab": "画面一覧 ⇄ セッションタブ切替",
    "help.move.esc": "入力モードからノーマルへ(選択は維持)",
    "help.sess.i": "入力モード(送信欄へ)。リストでは詳細/resume",
    "help.sess.enter": "確定 — 入力待ちセッションに ⏎ を送信",
    "help.sess.digits": "許可プロンプトの選択肢に応答(番号/カーソル両対応)",
    "help.sess.o": "詳細ポップアップ(ログ+送信)",
    "help.sess.f": "ターミナルへジャンプ(フォーカス)",
    "help.sess.m": "⇧Tab 送信(permission モード切替)",
    "help.sess.s": "Esc 送信(実行中の中断)",
    "help.life.n": "新規セッションパレット",
    "help.life.ctrln": "複製起動(同じプロジェクト・エージェント)",
    "help.life.ctrlc": "会話を引き継いで新タブ起動(resume)",
    "help.life.q": "選択セッションを終了 / 履歴を非表示",
    "help.org.p": "ピン留め(セッション単位で先頭固定)",
    "help.org.move": "カードを左 / 下 / 上 / 右へ並び替え(位置を交換)",
    "help.org.slash": "絞り込み検索(Enter でログ横断検索)",
    "help.org.colon": "コマンドライン(q / show / new / mask / esc / mode / key / /コマンド)",
    "help.org.mask": "マスクモード — スクリーンショット用に全テキストをスクランブル",
    "help.in.slash": "送信欄で / を打つとスラッシュコマンドのヒント表示",
    "help.in.tab": "ヒント補完 / パレットのエージェント切替",
    "help.in.enter": "入力待ちセッションに ⏎(確定)",
    "help.in.shiftenter": "送信欄内で改行(欄は自動で上に拡張)",
    "help.det.jk": "ログエントリを選択(1個 / ±5個 / 先頭・末尾)",
    "help.det.fold": "選択エントリの開閉トグル / 開く / 閉じる",
    "help.det.modes": "送信欄へ / 選択モードへ / 閉じる",
    "help.det.ops": "中断(Esc送信)/ モード切替 / コマンドライン(:q で表示中セッションを終了)",
    "help.det.dup": "表示中セッションを複製起動 / 会話を引き継いで起動(送信欄入力中も可)",
    "help.emptyEnter": "空欄で <kbd>Enter</kbd>",
  },
};

const SUPPORTED = Object.keys(STRINGS);

function detectLang() {
  const saved = localStorage.getItem("agd-lang");
  if (saved && SUPPORTED.includes(saved)) return saved;
  const nav = (navigator.language || "en").toLowerCase();
  return SUPPORTED.find(l => nav.startsWith(l)) || "en";
}

let lang = detectLang();
const getLang = () => lang;

// 未訳キーは英語 → キー名の順にフォールバックする(表示が空になるのを防ぐ)
function t(key, vars) {
  let s = STRINGS[lang]?.[key] ?? STRINGS.en[key] ?? key;
  if (vars) for (const k of Object.keys(vars)) s = s.replaceAll(`{${k}}`, vars[k]);
  return s;
}

function setLang(next) {
  if (!SUPPORTED.includes(next)) return false;
  lang = next;
  localStorage.setItem("agd-lang", next);
  document.documentElement.lang = next;
  applyStaticI18n();
  return true;
}

// index.html 側の静的文言を data 属性で差し替える。
//   data-i18n       → textContent
//   data-i18n-html  → innerHTML(<kbd> を含む文言用)
//   data-i18n-title → title 属性
//   data-i18n-ph    → placeholder 属性
function applyStaticI18n(root = document) {
  root.querySelectorAll("[data-i18n]").forEach(el => { el.textContent = t(el.dataset.i18n); });
  root.querySelectorAll("[data-i18n-html]").forEach(el => { el.innerHTML = t(el.dataset.i18nHtml); });
  root.querySelectorAll("[data-i18n-title]").forEach(el => { el.title = t(el.dataset.i18nTitle); });
  root.querySelectorAll("[data-i18n-ph]").forEach(el => { el.placeholder = t(el.dataset.i18nPh); });
}

document.documentElement.lang = lang;
