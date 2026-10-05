#!/bin/sh
set -eu
if command -v node >/dev/null || command -v npm >/dev/null; then
  echo 'Qualification requires no system Node/npm on PATH' >&2
  exit 1
fi
mkdir -m 700 "$HOME"
checksum=$(sha256sum /opt/archive.tar.gz)
sh /opt/install.sh --archive /opt/archive.tar.gz --sha256 "${checksum%% *}"
exec /opt/payload/runtime/bin/node /opt/test/qualify.mjs
