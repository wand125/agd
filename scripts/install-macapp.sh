#!/usr/bin/env bash
# agd をデスクトップアプリ風にセットアップする:
#   1. launchd でサーバーをログイン時に自動起動
#   2. ~/Applications/agd.app(専用プロファイルの Chrome アプリモードウィンドウ)を生成
#
# Chrome は --user-data-dir で完全に分離した専用プロファイルで起動するため、
# 通常プロファイルを操作するブラウザ自動化(Claude の Chrome 操作等)と干渉しない。
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BUN="$(command -v bun)"
PORT="${AGD_PORT:-8787}"
PLIST="$HOME/Library/LaunchAgents/com.agd.server.plist"
# /Applications に書ければそこへ(標準の場所)、無理なら ~/Applications
APP="/Applications/agd.app"
[[ -w /Applications ]] || APP="$HOME/Applications/agd.app"
PROFILE_DIR="$HOME/.cache/agd/chrome-profile"

# ---- 1. launchd: サーバー常駐 --------------------------------------------------
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.agd.server</string>
  <key>ProgramArguments</key>
  <array>
    <string>${BUN}</string>
    <string>run</string>
    <string>${REPO_DIR}/web/server.ts</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <!-- launchd の既定 PATH には homebrew や ~/.local/bin が無いため明示する -->
    <key>PATH</key><string>${HOME}/.local/bin:${HOME}/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>AGD_PORT</key><string>${PORT}</string>${AGD_TOKEN:+
    <key>AGD_TOKEN</key><string>${AGD_TOKEN}</string>}${AGD_PATH_STRIP:+
    <key>AGD_PATH_STRIP</key><string>${AGD_PATH_STRIP}</string>}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>/tmp/agd-server.log</string>
  <key>StandardErrorPath</key><string>/tmp/agd-server.log</string>
</dict>
</plist>
PLIST
launchctl bootout "gui/$(id -u)/com.agd.server" 2>/dev/null || true
sleep 1  # bootout 完了待ち(直後の bootstrap がレースで失敗するため)
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "✓ launchd: com.agd.server 登録(ログイン時自動起動、ログ: /tmp/agd-server.log)"

# ---- 2. agd.app ----------------------------------------------------------------
# 優先: WKWebView ネイティブシェル(swiftc があれば)。Dock クリックで既存ウィンドウに
# フォーカスし、Chrome と完全に無関係(ブラウザ自動化との干渉ゼロ)。
# フォールバック: Chrome アプリモード(専用プロファイル)。
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

if command -v swiftc > /dev/null; then
  echo "  swiftc でネイティブシェルをコンパイル中…"
  swiftc -O -o "$APP/Contents/MacOS/agd" "$REPO_DIR/scripts/AgdApp.swift" -framework Cocoa -framework WebKit
else
  CHROME=""
  for c in "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
           "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" \
           "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" \
           "/Applications/Chromium.app/Contents/MacOS/Chromium"; do
    [[ -x "$c" ]] && CHROME="$c" && break
  done
  if [[ -z "$CHROME" ]]; then
    echo "✗ swiftc も Chromium系ブラウザも見つかりません(agd.app はスキップ)"
    exit 0
  fi
  mkdir -p "$PROFILE_DIR"
  cat > "$APP/Contents/MacOS/agd" <<LAUNCHER
#!/usr/bin/env bash
PID=\$(ps -axo pid=,command= | grep -F -- "--user-data-dir=$PROFILE_DIR" | grep -v Helper | grep -v grep | awk '{print \$1}' | head -1)
if [[ -n "\$PID" ]]; then
  osascript -e "tell application \\"System Events\\" to set frontmost of (first process whose unix id is \$PID) to true" 2>/dev/null
  exit 0
fi
exec "$CHROME" \\
  --app="http://localhost:${PORT}" \\
  --user-data-dir="$PROFILE_DIR" \\
  --no-first-run --no-default-browser-check
LAUNCHER
fi
chmod +x "$APP/Contents/MacOS/agd"
cat > "$APP/Contents/Info.plist" <<INFO
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>agd</string>
  <key>CFBundleDisplayName</key><string>agd</string>
  <key>CFBundleIdentifier</key><string>com.agd.app</string>
  <key>CFBundleVersion</key><string>1.0</string>
  <key>CFBundleExecutable</key><string>agd</string>
  <key>CFBundleIconFile</key><string>agd.icns</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>LSEnvironment</key>
  <dict><key>AGD_PORT</key><string>${PORT}</string>${AGD_TOKEN:+
    <key>AGD_TOKEN</key><string>${AGD_TOKEN}</string>}</dict>
  <key>LSUIElement</key><false/>
</dict>
</plist>
INFO
# アイコン。macOS 標準の sips + iconutil で .icns を組む(追加ツール不要)。
# 以前は magick が無いと PNG をそのまま .icns という名前で置いていて、
# Finder や Dock で正しく表示されないことがあった。
SRC_ICON="$REPO_DIR/web/public/apple-touch-icon.png"
[[ -f "$SRC_ICON" ]] || SRC_ICON="$REPO_DIR/web/public/favicon-256.png"
if [[ -f "$SRC_ICON" ]]; then
  ICONSET="$(mktemp -d)/agd.iconset"
  mkdir -p "$ICONSET"
  for sz in 16 32 128 256 512; do
    sips -z $sz $sz "$SRC_ICON" --out "$ICONSET/icon_${sz}x${sz}.png" > /dev/null 2>&1
    sips -z $((sz*2)) $((sz*2)) "$SRC_ICON" --out "$ICONSET/icon_${sz}x${sz}@2x.png" > /dev/null 2>&1
  done
  if iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/agd.icns" 2>/dev/null; then
    echo "  アイコンを生成しました"
  else
    cp "$SRC_ICON" "$APP/Contents/Resources/agd.icns"   # 最低限は表示できるように
  fi
  rm -rf "$(dirname "$ICONSET")"
fi
touch "$APP"
# Spotlight / Finder から見つかるよう LaunchServices に登録
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP" 2>/dev/null || true
echo "✓ ${APP} 作成"
echo "  Spotlight や Dock から「agd」で起動できます"
