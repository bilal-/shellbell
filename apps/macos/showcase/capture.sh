#!/bin/sh
# Captures the Mac app's windows for shellbell.dev, filled from showcase/replies.json.
# Builds a debug copy under its own bundle id, so it shares no settings, service, pairing or
# power helper with an installed Shellbell. Usage: capture.sh OUTPUT_DIRECTORY [BUILD_NUMBER]
set -eu
out=${1:?Usage: capture.sh OUTPUT_DIRECTORY}
here=$(cd "$(dirname "$0")" && pwd)
macos=$(dirname "$here")
root=$(cd "$macos/../.." && pwd)
mkdir -p "$out"
out=$(cd "$out" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

swift build --package-path "$macos" --product Shellbell >/dev/null
bin=$(swift build --package-path "$macos" --show-bin-path)
app="$work/Shellbell.app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp "$bin/Shellbell" "$app/Contents/MacOS/Shellbell"
cp "$macos/Resources/Info.plist" "$app/Contents/Info.plist"
version=$(node -p "require('$root/apps/agent/package.json').version")
plutil -replace CFBundleIdentifier -string sh.bilal.shellbell.showcase "$app/Contents/Info.plist"
plutil -replace CFBundleShortVersionString -string "$version" "$app/Contents/Info.plist"
plutil -replace CFBundleVersion -string "${2:-1}" "$app/Contents/Info.plist"
cp "$root/brand/macos/shellbell-service.icns" "$app/Contents/Resources/ShellbellService.icns"
cp "$root/brand/macos/menu-bar/18/ShellbellTemplate.png" \
  "$root/brand/macos/menu-bar/18/ShellbellTemplate@2x.png" "$app/Contents/Resources/"
codesign -s - --force "$app" >/dev/null 2>&1

# One window per run: NAME SECTION HEIGHT [keep-awake]. The app saves its window and quits.
shoot() {
  SHELLBELL_SHOWCASE="$here/replies.json" SHELLBELL_SHOWCASE_SHOW="$2" \
    SHELLBELL_SHOWCASE_READY="$out/$1.png" SHELLBELL_SHOWCASE_HEIGHT="$3" SHELLBELL_SHOWCASE_KEEP_AWAKE="${4:-0}" \
    "$app/Contents/MacOS/Shellbell" </dev/null >/dev/null 2>&1
  test -s "$out/$1.png" || { echo "capture.sh: $1 was not drawn" >&2; exit 1; }
  echo "$out/$1.png"
}

shoot general Settings 860 1
shoot terminals Terminals 560
shoot devices Devices 480
shoot pair "Pair Device" 640
