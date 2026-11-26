import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import wire from "./companion/wire.cjs";

const stage = process.argv[2];
process.env.SHELLBELL_TABBY_DIR = path.resolve(stage, "bridge");
const plugin = (await import(pathToFileURL(path.resolve(stage, "adapter/adapter.mjs")).href))
  .default;
const unknown = Error("delivery-unknown");
const warnings = [];
const backend = plugin.create({
  log: { warn: (message) => warnings.push(message) },
  deliveryUnknown: () => unknown,
});
const config = wire.paths();
await backend.connect();
const clients = new Set();
const window = randomUUID();
function windowClient(version, correctKey, ids = {}) {
  const key = correctKey ? wire.readKey(config.key) : Buffer.alloc(32);
  const client = randomUUID(),
    id = ids.id ?? randomUUID(),
    group = randomUUID();
  const socket = net.createConnection(config.socket);
  clients.add(socket);
  let inputs = 0;
  const watches = [];
  let title = "Fixture";
  let sendInventory;
  const closed = once(socket, "close");
  let challenge;
  const send = wire.channel(socket, (msg) => {
    if (msg.op === "challenge") {
      challenge = msg.server;
      send({
        op: "proof",
        version,
        client,
        mac: wire.proof(key, "window", challenge, client, version),
      });
    } else if (msg.op === "ready") {
      assert(wire.matches(wire.proof(key, "agent", challenge, client, version), msg.mac));
      const inventory = () =>
        send({
          op: "inventory",
          window: ids.window ?? window,
          panes: [
            {
              id,
              group,
              tabIndex: 0,
              paneIndex: 0,
              title,
              cols: 80,
              rows: 24,
              pid: process.pid,
              cwd: "/tmp/shellbell-probe",
            },
          ],
        });
      sendInventory = inventory;
      if (ids.delayMs) setTimeout(inventory, ids.delayMs);
      else inventory();
    } else if (msg.op === "watch") {
      watches.push(msg.ids);
    } else if (msg.op === "input") {
      inputs++;
      socket.destroy(); // Terminal received input, but the adapter cannot know that.
    }
  });
  return {
    socket,
    retitle(next) {
      title = next;
      sendInventory?.();
    },
    watches,
    closed,
    get inputs() {
      return inputs;
    },
  };
}
try {
  await windowClient(wire.VERSION, false).closed;
  assert.equal(backend.isConnected, false);
  await windowClient(wire.VERSION + 1, true).closed;
  assert.equal(backend.isConnected, false);
  assert.match(warnings.at(-1), /Reopen Tabby/);
  const ready = new Promise((resolve) => {
    const off = backend.on(() => {
      if (backend.isConnected) {
        off();
        resolve();
      }
    });
  });
  const paneId = randomUUID();
  const first = windowClient(wire.VERSION, true, { id: paneId });
  await ready;
  const [before] = await backend.listSessions();
  assert.equal(before.cwd, "/tmp/shellbell-probe");
  // Without a controlling terminal there is no foreground program to report.
  const group = Number(
    execFileSync("ps", ["-o", "tpgid=", "-p", String(process.pid)], { encoding: "utf8" }),
  );
  if (group > 0) assert.match(backend.hostedProcess(before.id) ?? "", /node|tsx|zsh|bash/);
  else assert.equal(backend.hostedProcess(before.id), undefined);
  // A window that reconnects keeps its pane's identity and replaces the earlier connection.
  backend.setWatched([before.id]);
  const events = [];
  const offEvents = backend.on((event) => events.push(event));
  const client = windowClient(wire.VERSION, true, { id: paneId });
  await first.closed;
  const pane = await (async () => {
    for (let i = 0; i < 50; i++) {
      const [listed] = await backend.listSessions();
      if (listed) return listed;
      await new Promise((r) => setTimeout(r, 20));
    }
  })();
  assert.equal(pane?.id, before.id);
  // The replacement resumes the phone's watch and redraws output missed while disconnected.
  assert.deepEqual(client.watches.at(-1), [paneId]);
  assert(events.some((e) => e.type === "screen-changed" && e.sessionId === before.id));
  assert(!events.some((e) => e.type === "session-removed"));
  offEvents();
  await assert.rejects(backend.sendInput(pane.id, "x"), (error) => error === unknown);
  assert.equal(client.inputs, 1);
  await assert.rejects(backend.sendInput(pane.id, "x"));
  assert.deepEqual(await backend.listSessions(), []);
  // A pane missing from a reconnected window's inventory is reported as removed.
  const removed = [];
  const offRemoved = backend.on((e) => e.type === "session-removed" && removed.push(e.sessionId));
  const kept = windowClient(wire.VERSION, true, { window: randomUUID() });
  const keptWindow = await (async () => {
    for (let i = 0; i < 50; i++) {
      const [listed] = await backend.listSessions();
      if (listed) return listed;
      await new Promise((r) => setTimeout(r, 20));
    }
  })();
  const windowId = keptWindow.id.split("/")[0];
  windowClient(wire.VERSION, true, { window: windowId });
  await kept.closed;
  for (let i = 0; i < 50 && !removed.length; i++) await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(removed, [keptWindow.id]);
  const after = await backend.listSessions();
  assert.equal(after.length, 1);
  assert.notEqual(after[0].id, keptWindow.id);
  // A window whose connection closed first still reports the panes it lost when it returns.
  removed.length = 0;
  const [current] = after;
  [...clients].at(-1).destroy();
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(await backend.listSessions(), []);
  const returned = windowClient(wire.VERSION, true, { window: windowId });
  for (let i = 0; i < 50 && !removed.length; i++) await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(removed, [current.id]);
  // A window that never returns has its panes reported closed.
  removed.length = 0;
  const [last] = await backend.listSessions();
  returned.socket.destroy();
  await new Promise((r) => setTimeout(r, 5500));
  // Earlier windows in this probe that never returned are retired too.
  assert(removed.includes(last.id));
  offRemoved();
  // Connections that reset at once must never take the service down.
  await Promise.all(
    Array.from({ length: 40 }, () => {
      const s = net.createConnection(config.socket);
      s.on("error", () => {});
      s.destroy();
      return once(s, "close");
    }),
  );
  await new Promise((r) => setTimeout(r, 100));
  // A title-only update is a title change, not a layout change.
  const titled = windowClient(wire.VERSION, true, { window: randomUUID() });
  let titledId;
  for (let i = 0; i < 50 && !titledId; i++) {
    await new Promise((r) => setTimeout(r, 20));
    titledId = (await backend.listSessions()).find((s) => s.title === "Fixture")?.id;
  }
  assert(titledId);
  const kinds = [];
  const offKinds = backend.on((e) => kinds.push(e.type));
  titled.retitle("Working");
  for (let i = 0; i < 50 && !kinds.includes("title-changed"); i++)
    await new Promise((r) => setTimeout(r, 20));
  offKinds();
  assert(kinds.includes("title-changed"));
  assert(!kinds.includes("layout-changed"));
  // An older connection never takes a window back, even after the newer one has left.
  const contested = randomUUID();
  const older = windowClient(wire.VERSION, true, { window: contested, delayMs: 400 });
  const newer = windowClient(wire.VERSION, true, { window: contested });
  for (let i = 0; i < 50; i++) {
    if ((await backend.listSessions()).some((s) => s.id.startsWith(contested))) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  newer.socket.destroy();
  await older.closed;
  assert(!(await backend.listSessions()).some((s) => s.id.startsWith(contested)));
  console.log(
    "PASS: credential rejection, version mismatch, foreground process, stable reconnect identity, watch resume, pane removal, removal across a dropped connection, reset connections, title-only updates, older connection refused, lost input acknowledgment, connection retirement",
  );
} finally {
  for (const socket of clients) socket.destroy();
  await backend.close();
}
