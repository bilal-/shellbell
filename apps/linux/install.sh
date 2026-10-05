#!/bin/sh
# Download this file for inspection, then run it as your normal Linux user.
set -eu
PATH=/usr/bin:/bin
export PATH
LC_ALL=C
export LC_ALL
unset NODE_OPTIONS NODE_PATH
die() { printf 'Shellbell: %s\n' "$*" >&2; exit 1; }
usage() {
  printf '%s\n' 'Usage: sh install.sh --version VERSION' \
    '   or: sh install.sh --archive /absolute/archive.tar.gz --sha256 SHA256' \
    'Installs files for this user only; does not initialize or start a service.'
}
version= archive= checksum=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --help) usage; exit 0 ;;
    --version|--archive|--sha256)
      [ "$#" -ge 2 ] || die 'missing option value'
      case "$1" in
        --version) version=$2 ;;
        --archive) archive=$2 ;;
        --sha256) checksum=$2 ;;
      esac
      shift 2 ;;
    *) die 'unknown option; use --help' ;;
  esac
done
[ "$(uname -s)" = Linux ] || die 'Linux is required'
[ "$(id -u)" != 0 ] && [ "$(id -u)" = "$(id -ru)" ] || die 'run as a non-root user'
case "$(uname -m)" in
  x86_64) arch=x64 ;;
  aarch64) arch=arm64 ;;
  *) die 'unsupported CPU architecture' ;;
esac
if [ -n "$archive" ]; then
  [ -z "$version" ] || die 'choose either version or archive'
  case "$archive" in /*) ;; *) die 'archive must be an absolute path' ;; esac
else
  [ -n "$version" ] && [ -z "$checksum" ] || die 'an explicit version is required'
  [ "${#version}" -le 64 ] || die 'invalid version'
  printf '%s\n' "$version" | grep -Eq '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$' || die 'invalid version'
fi
for command in tar timeout sha256sum awk stat mktemp od getconf; do
  command -v "$command" >/dev/null || die "missing prerequisite: $command"
done
tar --version | grep -q 'GNU tar' || die 'GNU tar is required'
getconf GNU_LIBC_VERSION 2>/dev/null | awk '$1 == "glibc" {split($2,v,"."); if(v[1]>2 || (v[1]==2 && v[2]>=28)) ok=1} END {exit !ok}' || die 'glibc 2.28 or newer is required'
case "${HOME:-}" in /*) ;; *) die 'HOME must be absolute' ;; esac
[ ! -L "$HOME" ] || die 'unsafe HOME'
# Anchor every later read/write/exec to the admitted physical path, not an
# original alias whose parent could be replaced after the ancestry check.
HOME=$(readlink -f -- "$HOME") || die 'cannot resolve HOME'
export HOME
[ "$HOME" != / ] && [ -d "$HOME" ] && [ ! -L "$HOME" ] || die 'unsafe HOME'
[ "$(stat -c %u "$HOME")" = "$(id -u)" ] || die 'HOME must belong to this user'
home_mode=$(stat -c %a "$HOME")
[ "$((0$home_mode & 07022))" -eq 0 ] || die 'unsafe HOME permissions'
ancestor=$HOME
while [ "$ancestor" != / ]; do
  ancestor=$(dirname -- "$ancestor")
  ancestor_uid=$(stat -c %u "$ancestor")
  ancestor_mode=$(stat -c %a "$ancestor")
  [ "$ancestor_uid" = 0 ] || [ "$ancestor_uid" = "$(id -u)" ] || die 'unsafe HOME ancestor owner'
  if [ "$((0$ancestor_mode & 0022))" -ne 0 ]; then
    [ "$ancestor_uid" = 0 ] && [ "$((0$ancestor_mode & 01000))" -ne 0 ] || die 'unsafe HOME ancestor permissions'
  fi
done
umask 077
stage=$(mktemp -d "$HOME/.shellbell-install.XXXXXXXX") || die 'cannot create private staging directory'
# Keep failures for inspection. No broad automatic deletion in a bootstrap.
trap 'printf "Shellbell staging directory: %s\n" "$stage" >&2' EXIT
if [ -n "$archive" ]; then
  [ -f "$archive" ] && [ ! -L "$archive" ] || die 'archive must be a regular file'
  [ "$(stat -c %s "$archive")" -le 268435456 ] || die 'archive exceeds size limit'
  timeout 30 cp -- "$archive" "$stage/archive.tar.gz" || die 'archive copy failed'
else
  command -v curl >/dev/null || die 'curl is required for downloads'
  asset="shellbell-$version-linux-$arch.tar.gz"
  base="https://github.com/bilal-/shellbell/releases/download/shellbell%40$version"
  curl --proto '=https' --proto-redir '=https' -fL --connect-timeout 15 --max-time 180 --max-filesize 268435456 -o "$stage/archive.tar.gz" "$base/$asset" || die 'archive download failed'
  curl --proto '=https' --proto-redir '=https' -fL --connect-timeout 15 --max-time 30 --max-filesize 1024 -o "$stage/checksum" "$base/$asset.sha256" || die 'checksum download failed'
  checksum=$(awk -v asset="$asset" 'NR==1 && NF==2 && $2==asset {print $1; ok=1} END {if(NR!=1 || !ok) exit 1}' "$stage/checksum") || die 'invalid checksum document'
fi
[ "${#checksum}" -eq 64 ] || die 'invalid checksum'
case "$checksum" in *[!0-9a-f]*) die 'invalid checksum' ;; esac
[ "$(stat -c %s "$stage/archive.tar.gz")" -le 268435456 ] || die 'archive exceeds size limit'
actual=$(sha256sum "$stage/archive.tar.gz")
[ "${actual%% *}" = "$checksum" ] || die 'checksum mismatch'
# Bound decompression time and listing output; escape quoting exposes controls.
(ulimit -f 16384; timeout 30 tar --numeric-owner --full-time --quoting-style=escape -tvzf "$stage/archive.tar.gz" > "$stage/list") || die 'archive listing failed'
awk '
  function reject() {bad=1; exit 1}
  NF!=6 {reject()}
  {
    if ($1!="drwxr-xr-x" && $1!="drwx------" && $1!="-rw-r--r--" && $1!="-rwxr-xr-x") reject()
    if ($3 !~ /^[0-9]+$/ || $3>268435456) reject()
    total+=$3; if(total>1073741824 || NR>20000) reject()
    name=$6; sub(/\/$/, "", name)
    if(length(name)>249 || name !~ /^[A-Za-z0-9_@.+/-]+$/) reject()
    if(name!="shellbell" && name !~ /^shellbell\//) reject()
    n=split(name,parts,"/"); for(i=1;i<=n;i++) if(parts[i]=="" || parts[i]=="." || parts[i]=="..") reject()
    if(seen[name]++) reject()
    if(substr($1,1,1)=="-") files[name]=1
    if(name=="shellbell" && substr($1,1,1)!="d") reject()
  }
  END {
    if(bad || !files["shellbell/inventory.json"] || !files["shellbell/runtime/bin/node"] ||
       !files["shellbell/runtime/LICENSE"] || !files["shellbell/install.mjs"] ||
       !files["shellbell/agent/dist/cli.js"] || !files["shellbell/agent/package.json"]) exit 1
  }
' "$stage/list" || die 'unsafe archive'
mkdir "$stage/extracted"
(umask 022; timeout 60 tar --no-same-owner --no-same-permissions -xzf "$stage/archive.tar.gz" -C "$stage/extracted") || die 'archive extraction failed'
payload="$stage/extracted/shellbell"
header=$(od -An -tx1 -N6 "$payload/runtime/bin/node" | tr -d ' \n')
[ "$header" = 7f454c460201 ] || die 'runtime is not a Linux ELF64 executable'
machine=$(od -An -tu2 -j18 -N2 "$payload/runtime/bin/node" | tr -d ' \n')
case "$arch:$machine" in x64:62|arm64:183) ;; *) die 'runtime architecture mismatch' ;; esac
[ "$(timeout 10 "$payload/runtime/bin/node" --version)" = v22.23.1 ] || die 'runtime version mismatch'
if [ -n "$version" ]; then
  timeout 120 "$payload/runtime/bin/node" "$payload/install.mjs" --expected-version "$version"
else
  timeout 120 "$payload/runtime/bin/node" "$payload/install.mjs"
fi
