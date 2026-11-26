// Run only against the staged adapter. Match both random markers before sending any input.
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startTerminalPlugins } from "../../apps/agent/src/backends/plugin.js";
import { BackendRegistry } from "../../apps/agent/src/backends/registry.js";
import type { Screen } from "../../apps/agent/src/backends/types.js";

const [stage, first, second] = process.argv.slice(2);
assert(
  stage &&
    /^sbfixture_[\w-]+$/.test(first) &&
    /^sbfixture_[\w-]+$/.test(second) &&
    first !== second,
);
process.env.SHELLBELL_TABBY_DIR = resolve(stage, "bridge");
const log = {
  info() {},
  debug() {},
  warn(msg: string) {
    console.warn(msg);
  },
  error(msg: string) {
    console.error(msg);
  },
  child() {
    return log;
  },
};
const registry = new BackendRegistry(log);
const open = () =>
  startTerminalPlugins({
    registry,
    log,
    paths: [resolve(stage, "adapter/adapter.mjs")],
    retryMs: 250,
  });
let load = open();
const row = (screen: Screen, y: number) =>
  screen.lines[y]?.r
    .map((r) => r.t)
    .join("")
    .trimEnd();
async function until<T>(description: string, fn: () => Promise<T | undefined>) {
  const end = Date.now() + 30000;
  do {
    const result = await fn();
    if (result !== undefined) return result;
    await delay(100);
  } while (Date.now() < end);
  throw Error(`Timed out: ${description}`);
}
let layout = "Awaiting renderer";
try {
  await load.ready;
  const panes = await until("two disposable full-screen targets", async () => {
    const sessions = await registry.listSessions();
    const found = new Map<string, (typeof sessions)[number]>();
    for (const session of sessions) {
      if (!session.alternateScreen) continue;
      const screen = await registry.getScreen(session.id);
      const marker = row(screen, 0);
      if (marker !== first && marker !== second) continue;
      assert.deepEqual(screen.cursor, { x: 4, y: 2 });
      assert(screen.lines[0].r.some((r) => r.t === marker && r.b && r.fg === 1));
      found.set(marker, session);
    }
    layout = JSON.stringify({
      listed: sessions.length,
      matched: found.size,
      targets: [...found.values()].map((s) => ({
        focused: s.isFocusedOnMac,
        tab: s.tabIndex,
        pane: s.paneIndex,
      })),
      sameTab: found.size === 2 && found.get(first)?.tabId === found.get(second)?.tabId,
    });
    if (
      found.size === 2 &&
      found.get(first)?.tabId === found.get(second)?.tabId &&
      found.get(second)?.isFocusedOnMac !== found.get(first)?.isFocusedOnMac
    )
      return found;
  });
  const [a, b] = [...panes.values()].sort(
    (x, y) => Number(x.isFocusedOnMac) - Number(y.isFocusedOnMac),
  );
  assert.notEqual(a.id, b.id);
  assert.equal(a.title, b.title);
  assert.notEqual(a.paneIndex, b.paneIndex);
  assert.equal(a.isFocusedOnMac, false);
  assert.equal(b.isFocusedOnMac, true);
  registry.setWatched([a.id]);
  let dirty = false;
  const off = registry.on((e) => {
    if (e.type === "screen-changed" && e.sessionId === a.id) dirty = true;
  });
  await registry.sendInput(a.id, "x");
  await until("watched redraw", async () =>
    dirty && row(await registry.getScreen(a.id), 2) === "    RECEIVED" ? true : undefined,
  );
  assert.equal(row(await registry.getScreen(b.id), 2), "");
  off();
  await registry.sendInput(a.id, "q");
  // Tabby's "run" command keeps the pane open after the process exits.
  await until("Tabby close prompt", async () => {
    const screen = await registry.getScreen(a.id);
    return screen.lines.some((_, i) => /press any key to close/i.test(row(screen, i) ?? ""))
      ? true
      : undefined;
  });
  await registry.sendInput(a.id, "\r");
  await until("pane retirement", async () =>
    (await registry.listSessions()).some((p) => p.id === a.id) ? undefined : true,
  );
  await assert.rejects(registry.sendInput(a.id, "x"));
  assert.equal(row(await registry.getScreen(b.id), 2), "");
  await registry.member("tabby")!.close();
  load.stop();
  load = open();
  await load.ready;
  const survivor = a === panes.get(first) ? second : first;
  // A restarted service finds the surviving pane under the same identity.
  await until("replacement connection inventory", async () => {
    for (const pane of await registry.listSessions()) {
      if (pane.backend === "tabby" && row(await registry.getScreen(pane.id), 0) === survivor) {
        assert.equal(pane.id, b.id);
        return true;
      }
    }
  });
  assert.match(registry.member("tabby")?.hostedProcess?.(b.id.split(":")[1]) ?? "", /python/i);
  console.log(survivor);
  console.error(
    "PASS: registry discovery, alternate screen, styles, cursor, background input, watched redraw, stale pane refusal, stable identity after restart, foreground process",
  );
} catch (error) {
  console.error(layout);
  throw error;
} finally {
  load.stop();
}
