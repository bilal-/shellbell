#!/usr/bin/env bash
set -euo pipefail

platform="${1:?Usage: capture.sh ios|android device iphone|iphone-medium|iphone-duo|ipad|phone|tablet skill-directory [ios-display]}"
device="${2:?Pass an explicit simulator UDID or emulator serial}"
family="${3:?Pass the device family}"
skill_root="${4:?Pass the listing-kit skill directory}"
display="${5:-}"
app_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
raw="$app_root/output/listing-kit/$family"
mkdir -p "$raw"

case "$platform:$family" in
  ios:iphone|ios:iphone-medium|ios:iphone-duo|ios:ipad)
    destination="$app_root/fastlane/screenshots/en-US"
    ;;
  android:phone)
    destination="$app_root/fastlane/metadata/android/en-US/images/phoneScreenshots"
    ;;
  android:tablet)
    destination="$app_root/fastlane/metadata/android/en-US/images/tenInchScreenshots"
    ;;
  *) echo 'Unsupported platform/device family' >&2; exit 2 ;;
esac
if [ "$platform" = android ] && [[ "$device" != emulator-* ]]; then
  echo 'Listing captures require a disposable Android emulator' >&2
  exit 2
fi
mkdir -p "$destination"

for flow in "$app_root"/.listing-kit/flows/0*.yaml; do
  name="$(basename "$flow" .yaml)"
  maestro --device "$device" test "$flow" > "$raw/$name.log" 2>&1
  bash "$skill_root/scripts/capture/sanitize-status-bar.sh" "$platform" "$device"
  if [ "$platform" = ios ]; then
    display="${display:-primary}"
    size="$(python3 - "$app_root/.listing-kit/listing.json" "$family" <<'PY'
import json, sys
target = next(t for t in json.load(open(sys.argv[1]))['targets'] if t['family'] == sys.argv[2])
print(f"{target['width']}x{target['height']}")
PY
)"
    output="$destination/${name}_${family}.png"
    bash "$skill_root/scripts/capture/capture-ios.sh" "$device" "$display" "$size" "$output"
  else
    adb -s "$device" exec-out screencap -p > "$raw/$name.png"
    output="$destination/$name.png"
    # The emulator uses a native 9:16 or 16:9 viewport. No controls are cropped.
    bash "$skill_root/scripts/capture/normalize-screenshot.sh" "$raw/$name.png" "$output"
  fi
  magick "$output" -strip -depth 8 "PNG24:$output"
done
