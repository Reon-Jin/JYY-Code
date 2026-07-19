#!/usr/bin/env bash

set -euo pipefail

release_root="${1:-$(cd "$(dirname "$0")/../src-tauri/target/aarch64-apple-darwin/release" && pwd)}"
bundle_root="$release_root/bundle"
app_bundle="$(find "$bundle_root/macos" -maxdepth 1 -type d -name '*.app' -print -quit)"
dmg_path="$(find "$bundle_root/dmg" -maxdepth 1 -type f -name '*.dmg' -print -quit)"
updater_path="$(find "$bundle_root/macos" -maxdepth 1 -type f -name '*.tar.gz' -print -quit)"
updater_signature="${updater_path}.sig"

if [[ -z "$app_bundle" || ! -d "$app_bundle" ]]; then
  echo "macOS app bundle does not exist under $bundle_root/macos" >&2
  exit 1
fi
if [[ -z "$dmg_path" || ! -s "$dmg_path" ]]; then
  echo "macOS DMG does not exist or is empty under $bundle_root/dmg" >&2
  exit 1
fi
if [[ -z "$updater_path" || ! -s "$updater_path" || ! -s "$updater_signature" ]]; then
  echo "macOS updater artifact or signature does not exist under $bundle_root/macos" >&2
  exit 1
fi

main_name="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$app_bundle/Contents/Info.plist")"
main_binary="$app_bundle/Contents/MacOS/$main_name"
sidecar="$app_bundle/Contents/MacOS/jyycode-sidecar"

if [[ ! -x "$main_binary" ]]; then
  echo "macOS app executable is missing or not executable: $main_binary" >&2
  exit 1
fi
if [[ ! -x "$sidecar" ]]; then
  echo "macOS sidecar is missing or not executable: $sidecar" >&2
  exit 1
fi

codesign --verify --deep --strict --verbose=2 "$app_bundle"
hdiutil verify "$dmg_path"

desktop_pid=""
sidecar_pid=""
cleanup() {
  if [[ -n "$desktop_pid" ]] && kill -0 "$desktop_pid" 2>/dev/null; then
    kill -TERM "$desktop_pid" 2>/dev/null || true
  fi
  if [[ -n "$sidecar_pid" ]] && kill -0 "$sidecar_pid" 2>/dev/null; then
    kill -TERM "$sidecar_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT

"$main_binary" &
desktop_pid="$!"

deadline=$((SECONDS + 20))
while (( SECONDS < deadline )); do
  matches="$(pgrep -P "$desktop_pid" -x jyycode-sidecar || true)"
  children=()
  if [[ -n "$matches" ]]; then
    while IFS= read -r child; do
      children+=("$child")
    done <<< "$matches"
  fi
  if (( ${#children[@]} > 1 )); then
    echo "Desktop process $desktop_pid started more than one sidecar: ${children[*]}" >&2
    exit 1
  fi
  if (( ${#children[@]} == 1 )); then
    sidecar_pid="${children[0]}"
    break
  fi
  if ! kill -0 "$desktop_pid" 2>/dev/null; then
    echo "Desktop process exited before starting its sidecar" >&2
    exit 1
  fi
  sleep 0.2
done

if [[ -z "$sidecar_pid" ]]; then
  echo "Desktop process $desktop_pid did not start exactly one sidecar within 20 seconds" >&2
  exit 1
fi

/usr/bin/osascript -e 'tell application id "ai.jyycode.desktop" to quit' >/dev/null 2>&1 || kill -TERM "$desktop_pid"

deadline=$((SECONDS + 10))
while (( SECONDS < deadline )); do
  if ! kill -0 "$desktop_pid" 2>/dev/null; then
    break
  fi
  sleep 0.2
done
if kill -0 "$desktop_pid" 2>/dev/null; then
  echo "Desktop process $desktop_pid did not exit within 10 seconds" >&2
  exit 1
fi

deadline=$((SECONDS + 10))
while (( SECONDS < deadline )); do
  if ! kill -0 "$sidecar_pid" 2>/dev/null; then
    break
  fi
  sleep 0.2
done
if kill -0 "$sidecar_pid" 2>/dev/null; then
  echo "Owned sidecar remained after desktop exit: $sidecar_pid" >&2
  exit 1
fi

artifact_root="$release_root/desktop-artifacts"
rm -rf "$artifact_root"
mkdir -p "$artifact_root"
cp "$dmg_path" "$artifact_root/JYYCode-macos-aarch64.dmg"
cp "$updater_path" "$artifact_root/JYYCode-macos-aarch64.app.tar.gz"
cp "$updater_signature" "$artifact_root/JYYCode-macos-aarch64.app.tar.gz.sig"

(
  cd "$artifact_root"
  shasum -a 256 JYYCode-macos-aarch64.dmg JYYCode-macos-aarch64.app.tar.gz JYYCode-macos-aarch64.app.tar.gz.sig > SHA256SUMS.txt
)

desktop_pid=""
sidecar_pid=""
trap - EXIT

echo "macOS desktop smoke test passed."
echo "$app_bundle"
echo "$dmg_path"
echo "$artifact_root"
