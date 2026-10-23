#!/bin/sh
# Internal bootstrap for a verified local Mac disk image. Also used by shellbell update.
set -eu
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH
unset NODE_OPTIONS NODE_PATH ENV BASH_ENV CDPATH
die() { printf 'Shellbell: %s\n' "$*" >&2; exit 1; }
[ "$(uname -s)/$(uname -m)" = Darwin/arm64 ] || die 'an Apple silicon Mac is required'
[ "$(id -u)" != 0 ] && [ "$(id -u)" = "$(id -ru)" ] || die 'run as your normal user, without sudo'
archive= checksum= version= previous=
while [ "$#" -gt 0 ]; do
  [ "$#" -ge 2 ] || die 'missing option value'
  case "$1" in
    --archive) [ -z "$archive" ] || die 'duplicate archive'; archive=$2 ;;
    --sha256) [ -z "$checksum" ] || die 'duplicate checksum'; checksum=$2 ;;
    --target-version) [ -z "$version" ] || die 'duplicate version'; version=$2 ;;
    --update-from) [ -z "$previous" ] || die 'duplicate previous version'; previous=$2 ;;
    *) die 'unknown installer option' ;;
  esac
  shift 2
done
case "$archive" in /*) ;; *) die 'archive must be an absolute path' ;; esac
[ -f "$archive" ] && [ ! -L "$archive" ] || die 'archive must be a regular file'
[ "$(stat -f %z "$archive")" -le 268435456 ] || die 'disk image exceeds size limit'
[ "${#checksum}" = 64 ] || die 'invalid checksum'
case "$checksum" in *[!0-9a-f]*) die 'invalid checksum' ;; esac
printf '%s\n' "$version" | grep -Eq '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$' || die 'invalid version'
[ "${#version}" -le 32 ] || die 'invalid version'
if [ -n "$previous" ]; then
  printf '%s\n' "$previous" | grep -Eq '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$' || die 'invalid previous version'
  [ "${#previous}" -le 32 ] || die 'invalid previous version'
fi
installer_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
umask 077
scratch=$(mktemp -d /private/tmp/shellbell-dmg-install.XXXXXXXX)
mounted=false
cleanup() {
  if [ "$mounted" = true ]; then
    # Our own read-only mount can remain briefly busy after signature checks.
    # Forced detach is confined to this private mount, never a user's volume.
    hdiutil detach "$scratch/volume" -quiet || hdiutil detach "$scratch/volume" -force -quiet || {
      printf 'Shellbell: could not detach installer volume; retained %s\n' "$scratch" >&2
      return 1
    }
  fi
  # Only this invocation's private scratch, after its own volume is detached.
  rm -rf -- "$scratch"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
# Hash a private copy: never mount a caller-owned path that can change after hashing.
cp -- "$archive" "$scratch/release.dmg"
actual=$(shasum -a 256 "$scratch/release.dmg")
[ "${actual%% *}" = "$checksum" ] || die 'disk image checksum mismatch'
mkdir "$scratch/volume"
# Set before attach so partial attachment is not silently left behind.
mounted=true
hdiutil attach "$scratch/release.dmg" -readonly -nobrowse -noautoopen -noautofsck -mountpoint "$scratch/volume" -plist > "$scratch/mount.plist"
app="$scratch/volume/Shellbell.app"
[ -d "$app" ] && [ ! -L "$app" ] || die 'missing signed Shellbell app'
[ "$(plutil -extract CFBundleIdentifier raw -o - "$app/Contents/Info.plist")" = sh.bilal.shellbell.host ] || die 'unexpected app identifier'
[ "$(plutil -extract CFBundleShortVersionString raw -o - "$app/Contents/Info.plist")" = "$version" ] || die 'app version does not match the release'
# The published artifact hash identifies the expected publisher's exact bytes.
# Keep Apple's signature and Gatekeeper checks before executing its private Node.
codesign --verify --deep --strict "$app"
spctl --assess --type execute "$app"
"$app/Contents/Helpers/node" "$installer_dir/install.mjs" "$app" "$version" "$checksum" "$previous"
