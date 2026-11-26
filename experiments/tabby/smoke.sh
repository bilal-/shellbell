#!/usr/bin/env bash
# Give the path to a dedicated copy of the Tabby executable.
set -euo pipefail
umask 077
exe=${1:?Pass the path to the Tabby executable}
src=$(cd "$(dirname "$0")" && pwd -P)
repo=$(cd "$src/../.." && pwd -P)
stage=$("$src/stage.sh")
app_pid=
cleanup() {
  if [[ -n "$app_pid" ]]; then
    kill -TERM "$app_pid" 2>/dev/null || true
    wait "$app_pid" 2>/dev/null || true
  fi
  rm -rf -- "$stage"
}
trap cleanup EXIT
export SHELLBELL_TABBY_DIR="$stage/bridge"
node "$src/transport-probe.mjs" "$stage"
export TABBY_CONFIG_DIRECTORY="$stage/profile"
export TABBY_PLUGINS="$stage/profile/plugins/node_modules"
export SHELLBELL_TABBY_FIXTURE_PATH="$src/fixture.py"
cp -R "$src/test-layout" "$TABBY_PLUGINS/tabby-shellbell-fixture-layout"
suffix=$(node -p 'require("node:crypto").randomBytes(5).toString("hex")')
first="sbfixture_${suffix}_A"
second="sbfixture_${suffix}_B"
export SHELLBELL_TABBY_FIXTURES="$first,$second"
run_fixture() {
  "$exe" --user-data-dir="$stage/profile" run /usr/bin/python3 "$src/fixture.py" "$1"
}
"$exe" --user-data-dir="$stage/profile" run /usr/bin/python3 "$src/fixture.py" "$first" > /dev/null 2>&1 &
app_pid=$!
# Only the disposable fixture writes this readiness marker.
node --input-type=module - "$stage/bridge/$first.ready" <<'JS'
import {existsSync} from 'node:fs'
import {setTimeout} from 'node:timers/promises'
const deadline = Date.now() + 30000
while (!existsSync(process.argv[2])) {
  if (Date.now() > deadline) throw Error('First Tabby fixture did not start')
  await setTimeout(100)
}
JS
run_fixture "$second" > /dev/null 2>&1
cd "$repo"
survivor=$(node_modules/.bin/tsx experiments/tabby/probe.mts "$stage" "$first" "$second")
export SHELLBELL_TABBY_PROBE_MARKER="$survivor"
export SHELLBELL_TABBY_PROBE_ADAPTER="$stage/adapter/adapter.mjs"
pnpm -F shellbell exec vitest run test/agent.integration.test.ts -t 'mirrors the staged Tabby'
