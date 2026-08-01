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
APP="$HOME/Applications/agd.app"
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
    <key>AGD_PORT</key><string>${PORT}</string>${AGD_PATH_STRIP:+
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

# ---- 2. agd.app(Chrome アプリモード・専用プロファイル) -----------------------
CHROME=""
for c in "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
         "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" \
         "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" \
         "/Applications/Chromium.app/Contents/MacOS/Chromium"; do
  [[ -x "$c" ]] && CHROME="$c" && break
done
if [[ -z "$CHROME" ]]; then
  echo "✗ Chromium系ブラウザが見つかりません(agd.app はスキップ。ブラウザで http://localhost:${PORT} を開いてください)"
  exit 0
fi

mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" "$PROFILE_DIR"
cat > "$APP/Contents/MacOS/agd" <<LAUNCHER
#!/usr/bin/env bash
exec "$CHROME" \\
  --app="http://localhost:${PORT}" \\
  --user-data-dir="$PROFILE_DIR" \\
  --no-first-run --no-default-browser-check
LAUNCHER
chmod +x "$APP/Contents/MacOS/agd"
cat > "$APP/Contents/Info.plist" <<'INFO'
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
  <key>LSUIElement</key><false/>
</dict>
</plist>
INFO
if command -v magick > /dev/null && [[ -f "$REPO_DIR/web/public/favicon-256.png" ]]; then
  magick "$REPO_DIR/web/public/favicon-256.png" "$APP/Contents/Resources/agd.icns" 2>/dev/null || true
fi
touch "$APP"
echo "✓ ~/Applications/agd.app 作成(専用プロファイル: $PROFILE_DIR)"
echo "  Spotlight や Dock から「agd」で起動できます"
