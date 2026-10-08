#!/usr/bin/env bash
set -euo pipefail

device="${1:?Pass an explicit disposable Android emulator serial}"
app_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ "$device" != emulator-* ]]; then
  echo 'List navigation checks require a disposable Android emulator' >&2
  exit 2
fi
version="$(adb -s "$device" shell dumpsys package sh.bilal.shellbell | sed -n 's/^[[:space:]]*versionName=//p')"
if [[ "$version" != *-listing-capture ]]; then
  echo 'Install the offline listingCapture APK before running this destructive demo-state check' >&2
  exit 2
fi

keys=(animator_duration_scale transition_animation_scale window_animation_scale)
previous=()
for key in "${keys[@]}"; do
  previous+=("$(adb -s "$device" shell settings get global "$key" | tr -d '\r')")
done
restore() {
  local i
  for i in "${!keys[@]}"; do
    if [[ "${previous[$i]}" == null ]]; then
      adb -s "$device" shell settings delete global "${keys[$i]}"
    else
      adb -s "$device" shell settings put global "${keys[$i]}" "${previous[$i]}"
    fi
  done
}
trap restore EXIT

# Tapping a visibly displaced row must open that session, including when Android
# disables animations. Source tests cannot exercise Fabric/Reanimated geometry.
for scale in 0 1; do
  for key in "${keys[@]}"; do
    adb -s "$device" shell settings put global "$key" "$scale"
  done
  echo "Checking computer and session navigation with animation scale $scale"
  maestro --device "$device" test "$app_root/.listing-kit/flows/01_terminal.yaml"
done
