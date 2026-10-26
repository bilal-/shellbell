#!/bin/sh
# Builds node_datachannel.node from the sources build.mjs fetched, with OpenSSL linked statically.
# Runs inside the Linux build container, or directly on a Mac. Data channels only: no media
# (so no libsrtp) and no WebSocket code, which Shellbell never uses.
set -eu
src=$1
out=$2
# A Mac builds either architecture: arm64 or x64.
arch=${3:-}
jobs=${JOBS:-4}
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
# The fetched sources stay read-only; each build works on its own copy.
mkdir "$work/src"
cp -R "$src/node-datachannel" "$src/libdatachannel" "$src/openssl.tar.gz" "$work/src/"
src=$work/src

tar -xzf "$src/openssl.tar.gz" -C "$work"
cd "$work"/openssl-*
case "$(uname -s)/$arch" in
  Darwin/arm64) target=darwin64-arm64-cc ;;
  Darwin/x64) target=darwin64-x86_64-cc ;;
  *) target= ;;
esac
# shellcheck disable=SC2086 # $target is empty on Linux, where Configure detects the platform.
./Configure $target no-shared no-tests no-docs no-apps -fPIC --prefix="$work/openssl" --libdir=lib >/dev/null
make -j"$jobs" build_libs >/dev/null
make install_dev >/dev/null

cd "$src/node-datachannel"
# Only the build tools, at the versions in upstream's lock file (which is out of step with its
# package.json, so `npm ci` refuses it). The bindings' CMake reads the headers from node_modules.
mkdir "$work/tools"
echo '{"private":true}' > "$work/tools/package.json"
npm install --prefix "$work/tools" --ignore-scripts --no-audit --no-fund --save-exact \
  cmake-js@7.3.0 node-addon-api@7.0.0 node-api-headers@1.4.0 >/dev/null
ln -s "$work/tools/node_modules" node_modules
rm -rf build
export CMAKE_BUILD_PARALLEL_LEVEL="$jobs"
"$work/tools/node_modules/.bin/cmake-js" build -G "Unix Makefiles" ${arch:+--arch "$arch"} \
  --CDOPENSSL_ROOT_DIR="$work/openssl" \
  --CDOPENSSL_USE_STATIC_LIBS=TRUE \
  --CDNO_MEDIA=ON \
  --CDNO_WEBSOCKET=ON \
  --CDFETCHCONTENT_SOURCE_DIR_LIBDATACHANNEL="$src/libdatachannel" \
  --CDFETCHCONTENT_FULLY_DISCONNECTED=ON \
  --CDCMAKE_POLICY_VERSION_MINIMUM=3.5
mkdir -p "$out"
cp build/Release/node_datachannel.node "$out/node_datachannel.node"
