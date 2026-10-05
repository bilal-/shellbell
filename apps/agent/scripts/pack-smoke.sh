#!/usr/bin/env bash
# Packs `shellbell` and installs the tarball into a throwaway prefix to prove `npx shellbell`
# would work. Publishes nothing and touches nothing outside $TMPDIR. Asserts on the CLI's
# actual output (not just exit codes) run through npm's bin symlink -- exit 0 with no output
# is exactly the failure mode this test exists to catch.
set -euo pipefail
cd "$(dirname "$0")/.."
PREFIX="$(mktemp -d)"
trap 'rm -rf "$PREFIX"' EXIT
rm -f shellbell-*.tgz
pnpm pack
TARBALL="$(ls shellbell-*.tgz)"
echo "packed $TARBALL"
npm install -g --prefix "$PREFIX" "./$TARBALL"

EXPECTED_VERSION="$(node -p "require('./package.json').version")"
ACTUAL_VERSION="$("$PREFIX/bin/shellbell" --version)"
if [ "$ACTUAL_VERSION" != "$EXPECTED_VERSION" ]; then
  echo "pack-smoke: --version printed \"$ACTUAL_VERSION\", expected \"$EXPECTED_VERSION\"" >&2
  exit 1
fi

HELP_OUTPUT="$("$PREFIX/bin/shellbell" --help)"
if [[ "$HELP_OUTPUT" != *pair* ]]; then
  echo "pack-smoke: --help output did not contain \"pair\"" >&2
  exit 1
fi

npm uninstall -g --prefix "$PREFIX" shellbell
rm -f "$TARBALL"
echo "pack-smoke: ok"
