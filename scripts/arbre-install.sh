#!/usr/bin/env bash
# Installs the newest arbre build of T3 Code from the sanztheo/t3code releases over
# /Applications/T3 Code (Nightly).app. The previous app goes to the Trash; app data in ~/.t3 is
# never touched. Needs an authenticated `gh`.
#
# Undo: reinstall the official nightly DMG from https://github.com/pingdotgg/t3code/releases.
set -euo pipefail

REPO="sanztheo/t3code"
# Nightly-channel builds are named this way by build-desktop-artifact.ts (resolveDesktopProductName).
APP_NAME="T3 Code (Nightly)"
APP_PATH="/Applications/$APP_NAME.app"
export ARBRE_TAG_PATTERN='^v[0-9]+\.[0-9]+\.[0-9]+-nightly\.[0-9]{8}\.[0-9]+$'

# Arbre builds are prereleases, which `gh release download` without a tag skips.
tag="$(gh release list --repo "$REPO" --limit 100 --json tagName,createdAt \
  --jq '[.[] | select(.tagName | test(env.ARBRE_TAG_PATTERN))] | sort_by(.createdAt) | reverse | .[0].tagName // ""')"
if [[ -z "$tag" ]]; then
  echo "No arbre release found on $REPO." >&2
  exit 1
fi

download_dir="${TMPDIR:-/tmp}/arbre"
mount_dir="$(mktemp -d "${TMPDIR:-/tmp}/arbre-dmg.XXXXXX")"
cleanup() {
  hdiutil detach "$mount_dir" -quiet 2>/dev/null || true
  rmdir "$mount_dir" 2>/dev/null || true
  rm -rf "$download_dir"
}
trap cleanup EXIT

echo "Downloading $tag..."
rm -rf "$download_dir"
gh release download "$tag" --repo "$REPO" --pattern '*arm64.dmg' -D "$download_dir"
dmg="$(ls "$download_dir"/*arm64.dmg)"

was_running=false
if pgrep -f "$APP_PATH/Contents/MacOS/" >/dev/null; then
  was_running=true
  echo "Quitting $APP_NAME..."
  osascript -e "tell application \"$APP_PATH\" to quit"
  for _ in $(seq 1 30); do
    pgrep -f "$APP_PATH/Contents/MacOS/" >/dev/null || break
    sleep 1
  done
  if pgrep -f "$APP_PATH/Contents/MacOS/" >/dev/null; then
    echo "$APP_NAME is still running; quit it and run this script again." >&2
    exit 1
  fi
fi

hdiutil attach -nobrowse -readonly -quiet -mountpoint "$mount_dir" "$dmg"
if [[ ! -d "$mount_dir/$APP_NAME.app" ]]; then
  echo "$dmg does not contain $APP_NAME.app." >&2
  exit 1
fi

if [[ -d "$APP_PATH" ]]; then
  trashed="$HOME/.Trash/$APP_NAME $(date +%Y%m%d-%H%M%S).app"
  echo "Moving the current app to $trashed"
  mv "$APP_PATH" "$trashed"
fi
ditto "$mount_dir/$APP_NAME.app" "$APP_PATH"
# The app is self-signed, not notarized: without this, Gatekeeper refuses to open it.
xattr -dr com.apple.quarantine "$APP_PATH" 2>/dev/null || true

version="$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$APP_PATH/Contents/Info.plist")"
echo "Installed $APP_NAME $version ($tag)."
if [[ "$was_running" == true ]]; then
  open "$APP_PATH"
fi
