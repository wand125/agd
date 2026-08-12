// agd デスクトップアプリ(WKWebView シェル)
// Chrome に依存しない単一ウィンドウのラッパー。Dock クリックは既存ウィンドウを前面化する。
// scripts/install-macapp.sh がインストール時に swiftc でコンパイルする。
import Cocoa
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate, WKUIDelegate, WKNavigationDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    private var retryTimer: Timer?

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()
        let rect = NSRect(x: 0, y: 0, width: 1520, height: 940)
        window = NSWindow(
            contentRect: rect,
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered, defer: false)
        window.title = "agd"
        window.isReleasedWhenClosed = false
        window.setFrameAutosaveName("agdMainWindow")
        window.center()

        webView = WKWebView(frame: rect, configuration: WKWebViewConfiguration())
        webView.uiDelegate = self
        webView.navigationDelegate = self
        load()
        window.contentView = webView
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private var dashboardURL: URL {
        let env = ProcessInfo.processInfo.environment
        let port = env["AGD_PORT"] ?? "8787"
        // サーバーが AGD_TOKEN 付きで動いている場合は URL に載せる。
        // サーバー側はループバックを免除しない(プロキシ経由の外部アクセスも
        // 127.0.0.1 から来るため)ので、ローカルのアプリでもトークンが要る。
        let token = env["AGD_TOKEN"] ?? ""
        let q = token.isEmpty ? "" : "?token=\(token)"
        return URL(string: "http://127.0.0.1:\(port)/\(q)")!
    }

    private func load() {
        // キャッシュを使わず必ずサーバーに問い合わせる(古い画面で固まるのを防ぐ)
        webView.load(URLRequest(url: dashboardURL, cachePolicy: .reloadIgnoringLocalCacheData))
    }

    @objc func reloadPage(_ sender: Any?) {
        retryTimer?.invalidate(); retryTimer = nil
        load()
    }

    // サーバー再起動中などで読み込みに失敗したら、復帰まで2秒ごとに再試行する。
    // これが無いと空白のまま固まり、ユーザーに復旧手段が無くなる。
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        scheduleRetry()
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        scheduleRetry()
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        retryTimer?.invalidate(); retryTimer = nil
    }
    // レンダラー(Webプロセス)が落ちた場合も自動で復帰させる
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        load()
    }

    private func scheduleRetry() {
        guard retryTimer == nil else { return }
        retryTimer = Timer.scheduledTimer(withTimeInterval: 2.0, repeats: true) { [weak self] _ in
            self?.load()
        }
    }

    // Dock クリック時: 新規ウィンドウは作らず既存を前面化(閉じていたら再表示)
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { window.makeKeyAndOrderFront(nil) }
        NSApp.activate(ignoringOtherApps: true)
        return true
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    // target=_blank(ログ内のURLリンク等)は既定ブラウザで開く
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url { NSWorkspace.shared.open(url) }
        return nil
    }

    // Cmd+C/V 等の標準編集操作と Cmd+Q/W のために最小限のメニューを組む
    private func buildMenu() {
        let main = NSMenu()

        let appItem = NSMenuItem()
        main.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(NSMenuItem(title: "agd を隠す", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h"))
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(NSMenuItem(title: "agd を終了", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        appItem.submenu = appMenu

        let editItem = NSMenuItem()
        main.addItem(editItem)
        let editMenu = NSMenu(title: "編集")
        editMenu.addItem(NSMenuItem(title: "取り消す", action: Selector(("undo:")), keyEquivalent: "z"))
        editMenu.addItem(NSMenuItem(title: "やり直す", action: Selector(("redo:")), keyEquivalent: "Z"))
        editMenu.addItem(NSMenuItem.separator())
        editMenu.addItem(NSMenuItem(title: "カット", action: #selector(NSText.cut(_:)), keyEquivalent: "x"))
        editMenu.addItem(NSMenuItem(title: "コピー", action: #selector(NSText.copy(_:)), keyEquivalent: "c"))
        editMenu.addItem(NSMenuItem(title: "ペースト", action: #selector(NSText.paste(_:)), keyEquivalent: "v"))
        editMenu.addItem(NSMenuItem(title: "すべてを選択", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a"))
        editItem.submenu = editMenu

        let viewItem = NSMenuItem()
        main.addItem(viewItem)
        let viewMenu = NSMenu(title: "表示")
        viewMenu.addItem(NSMenuItem(title: "再読み込み", action: #selector(reloadPage(_:)), keyEquivalent: "r"))
        viewItem.submenu = viewMenu

        let windowItem = NSMenuItem()
        main.addItem(windowItem)
        let windowMenu = NSMenu(title: "ウインドウ")
        windowMenu.addItem(NSMenuItem(title: "しまう", action: #selector(NSWindow.miniaturize(_:)), keyEquivalent: "m"))
        windowMenu.addItem(NSMenuItem(title: "閉じる", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w"))
        windowItem.submenu = windowMenu

        NSApp.mainMenu = main
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
