#!/usr/bin/env bash
# Stage a disposable pair. Existing profiles are never modified.
set -euo pipefail
umask 077
src=$(cd "$(dirname "$0")" && pwd -P)
dest=$(mktemp -d "/tmp/shellbell-tabby.XXXXXXXX")
dest=$(cd "$dest" && pwd -P)
mkdir "$dest/adapter" "$dest/bridge" "$dest/profile"
mkdir "$dest/adapter/companion"
cp "$src/companion/wire.cjs" "$dest/adapter/companion"
cp "$src/adapter.mjs" "$dest/adapter"
mkdir -p "$dest/profile/plugins/node_modules"
cp -R "$src/companion" "$dest/profile/plugins/node_modules/tabby-shellbell"
headers=$(node -p 'require("node:path").resolve(process.execPath, "../../include/node")')
case $(uname -s) in
  Darwin) flags=(-bundle -undefined dynamic_lookup);;
  Linux) flags=(-shared -fPIC -D_GNU_SOURCE);;
  *) exit 1;;
esac
cc "${flags[@]}" -I"${NODE_INCLUDE_DIR:-$headers}" "$src/peer.c" -o "$dest/adapter/peer.node"
chmod 600 "$dest/adapter/adapter.mjs"
printf '%s\n' "$dest"
