/*
 * Spike: the Herdr socket API from Node. Run with `pnpm -F shellbell spike:herdr` while a real
 * herdr server is running for this user, ideally with at least one coding agent pane. It writes
 * sanitized fixtures into test/fixtures/ and prints a local summary for fixture review.
 *
 * Read-only by default. Set HERDR_SPIKE_KEYS=1 to also probe `pane.send_keys` — the probe creates
 * its OWN scratch tab (`tab.create`, unfocused) and closes it in a `finally`; it never sends a key
 * to a pane it did not create itself.
 *
 * Every capture step below runs through `step()` (or the step-aware `timed()`), which try/catches
 * it, records a failure into `failures` instead of throwing, and lets the rest of the run
 * continue — a stale pane or an unsupported method on one step never aborts the whole spike, and
 * fixtures already written (synchronous `writeFileSync`) survive regardless of what fails later.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { connect as netConnect } from "node:net";
import { homedir, hostname, userInfo } from "node:os";
import { join } from "node:path";
import { NAMED_KEYS, type NamedKey } from "@shellbell/protocol";
import {
  HerdrClient,
  HerdrError,
  herdrSocketPath,
  semverAtLeast,
} from "../src/backends/herdr/client.js";
import { HERDR_KEYS } from "../src/backends/herdr/keys.js";
import type { PaneInfoResult, TabCreatedResult } from "../src/backends/herdr/types.js";
import { createLogger } from "../src/log.js";

const log = createLogger({ stdout: true, verbose: true });
const client = new HerdrClient({ log, requestTimeoutMs: 5000 });
const outDir = join(import.meta.dirname, "..", "test", "fixtures");
mkdirSync(outDir, { recursive: true });

const writtenFixtures: string[] = [];
interface Failure {
  step: string;
  error: string;
}
const failures: Failure[] = [];

/** Replace this machine's identity before anything is written to disk or printed. */
function sanitize<T>(value: T): T {
  const home = homedir();
  const user = userInfo().username;
  const host = hostname();
  const shortHost = host.split(".")[0] ?? host;
  // Paths are replaced as substrings; identifiers (user, host) only at word boundaries so a short
  // hostname such as "mac" cannot corrupt words like "package" inside captured pane text.
  const escapeRegex = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const word = (v: string) => new RegExp(`(?<![A-Za-z0-9_])${escapeRegex(v)}(?![A-Za-z0-9_])`, "g");
  let text = JSON.stringify(value).split(home).join("/Users/dev");
  if (user) text = text.replace(word(user), "dev");
  text = text.replace(word(host), "<host>");
  if (shortHost && shortHost !== host) text = text.replace(word(shortHost), "<host>");
  return JSON.parse(text) as T;
}

function save(name: string, value: unknown): void {
  const file = join(outDir, name);
  writeFileSync(file, `${JSON.stringify(sanitize(value), null, 2)}\n`);
  console.log("wrote", file);
  writtenFixtures.push(file);
}

/** Runs one capture step; records a failure instead of throwing so the rest of the spike keeps
 * going and fixtures captured so far still get written. */
async function step<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    const code = err instanceof HerdrError ? err.code : undefined;
    const message = err instanceof Error ? err.message : String(err);
    failures.push({ step: label, error: code ? `${code}: ${message}` : message });
    console.error(`!! step "${label}" failed:`, code ? `${code}: ${message}` : message);
    return undefined;
  }
}

/** Same as `step()`, but for a repeated latency sample: one failed sample is recorded and
 * skipped rather than aborting the remaining samples. */
async function timed<T>(label: string, n: number, fn: () => Promise<T>): Promise<T | undefined> {
  const times: number[] = [];
  let last: T | undefined;
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    try {
      last = await fn();
    } catch (err) {
      const code = err instanceof HerdrError ? err.code : undefined;
      const message = err instanceof Error ? err.message : String(err);
      failures.push({
        step: `${label} (sample ${i + 1}/${n})`,
        error: code ? `${code}: ${message}` : message,
      });
      console.error(`!! ${label} sample ${i + 1}/${n} failed:`, message);
      continue;
    }
    times.push(performance.now() - t0);
  }
  if (times.length === 0) {
    console.log(`${label}: no successful samples (n=${n})`);
    return last;
  }
  times.sort((a, b) => a - b);
  const p50 = times[Math.floor(times.length / 2)] ?? 0;
  console.log(
    `${label}: p50 ${p50.toFixed(1)} ms, max ${(times.at(-1) ?? 0).toFixed(1)} ms (n=${times.length}/${n})`,
  );
  return last;
}

/** Research §10.1: prove the server really does read exactly one line per connection. */
function twoRequestsOnOneConnection(path: string): Promise<string[]> {
  return new Promise((resolve) => {
    const lines: string[] = [];
    const socket = netConnect({ path });
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ id: "a", method: "ping", params: {} })}\n`);
      socket.write(`${JSON.stringify({ id: "b", method: "ping", params: {} })}\n`);
    });
    socket.on("data", (c) => lines.push(...c.toString().split("\n").filter(Boolean)));
    socket.on("close", () => resolve(lines));
    setTimeout(() => socket.destroy(), 2000);
  });
}

interface PaneRow {
  pane_id: string;
  terminal_id?: string;
  scroll?: Record<string, unknown>;
}

interface LayoutRow {
  panes?: { pane_id: string; rect?: { width?: number; height?: number } }[];
}

function findPaneRectHeight(layouts: LayoutRow[], paneId: string): number | undefined {
  for (const l of layouts) {
    const p = l.panes?.find((pp) => pp.pane_id === paneId);
    if (p?.rect?.height !== undefined) return p.rect.height;
  }
  return undefined;
}

async function main(): Promise<void> {
  const path = herdrSocketPath();
  const clientSockSibling = path.replace(/\.sock$/, "-client.sock");
  const socketExists = existsSync(path);
  // M-4: `path` contains $HOME and the OS username -- `sanitize()` already scrubs every fixture
  // before it is written, so the console output and the paste-ready summary below must go through
  // it too, not just the files.
  console.log("socket:", sanitize(path), "HERDR_SESSION:", process.env.HERDR_SESSION ?? "(unset)");
  console.log(
    "socket exists:",
    socketExists,
    "  -client.sock sibling exists:",
    existsSync(clientSockSibling),
  );
  // Spike question 1 is blocking: the macOS default (`~/.config/herdr/…`, no
  // `~/Library/Application Support` branch) is read from the Rust source but never observed on a
  // Mac. Say so loudly rather than dying with a bare ENOENT that reads like "herdr isn't running".
  if (!socketExists) {
    console.error(
      `\n!! No socket at ${path}\n` +
        "!! If a herdr server IS running, herdrSocketPath() is WRONG for this platform.\n" +
        '!! Check: ls -l ~/.config/herdr/ "$HOME/Library/Application Support/herdr/"\n' +
        "!! Record the real path as errata (spike question 1) — Task 6's detector and the doctor\n" +
        '!! check will both silently report "not installed" until herdrSocketPath() is fixed.\n' +
        "!! Workaround for the rest of this spike: HERDR_SOCKET_PATH=<real path> pnpm -F shellbell spike:herdr\n",
    );
  }

  const pong = await timed("ping", 5, () =>
    client.request<{ version?: string; protocol?: number; capabilities?: unknown }>("ping", {}),
  );
  const versionGate = pong ? semverAtLeast(pong.version ?? "", [0, 7, 2]) : undefined;
  if (pong) {
    console.log("version gate:", pong.version, "->", versionGate);
    console.log("capabilities:", JSON.stringify(pong.capabilities ?? null).slice(0, 300));
    save("herdr-ping.json", { id: "sb1", result: pong });
  }

  const snapshot = await timed("session.snapshot", 5, () =>
    client.request<{ snapshot: Record<string, unknown> }>("session.snapshot", {}),
  );
  if (snapshot) save("herdr-session-snapshot.json", { id: "sb2", result: snapshot });

  const panes = (snapshot?.snapshot.panes ?? []) as PaneRow[];
  const layouts = (snapshot?.snapshot.layouts ?? []) as LayoutRow[];
  const allHaveTerminalId = panes.length > 0 && panes.every((p) => Boolean(p.terminal_id));
  console.log(
    "panes:",
    panes.map((p) => `${p.pane_id}/${p.terminal_id ?? "NO terminal_id"}`),
  );
  console.log("every pane carries terminal_id:", allHaveTerminalId);
  console.log("scroll on pane 0:", JSON.stringify(panes[0]?.scroll ?? null));
  const firstLayout = layouts[0] as unknown;
  console.log(
    "layout rect field names (pane 0 of layout 0):",
    firstLayout
      ? Object.keys(
          ((firstLayout as LayoutRow).panes?.[0] as { rect?: object } | undefined)?.rect ?? {},
        )
      : "(no layouts)",
  );
  console.log("layouts:", JSON.stringify(layouts).slice(0, 400));
  const paneId = panes[0]?.pane_id;
  if (!paneId) failures.push({ step: "pane selection", error: "no panes in session.snapshot" });

  let visibleRows: number | undefined;
  let csiFinals: string[] = [];
  if (paneId) {
    const visible = await timed("pane.read visible ansi", 20, () =>
      client.request("pane.read", { pane_id: paneId, source: "visible", format: "ansi" }),
    );
    if (visible) {
      save("herdr-pane-read-visible.json", { id: "sb7", result: visible });
      const text = (visible as { read: { text?: string } }).read.text ?? "";
      // Built from a string, not a regex literal: an ESC char in a `/.../ ` regex trips Biome's
      // noControlCharactersInRegex rule, but we need to match the real CSI escape byte here.
      const csiFinal = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*([A-Za-z])`, "g");
      csiFinals = [...new Set([...text.matchAll(csiFinal)].map((m) => m[1] ?? ""))];
      console.log("escape finals seen (expect only 'm'):", csiFinals.join(" "));
      visibleRows = text.split("\n").length;
      console.log("rows returned:", visibleRows);
      const expectedHeight = findPaneRectHeight(layouts, paneId);
      console.log(
        "row count vs layout rect height:",
        visibleRows,
        "vs",
        expectedHeight ?? "(no rect found)",
      );
    }

    const recent = await timed("pane.read recent ansi 200", 5, () =>
      client.request("pane.read", {
        pane_id: paneId,
        source: "recent",
        format: "ansi",
        lines: 200,
      }),
    );
    if (recent) save("herdr-pane-read-recent.json", { id: "sb8", result: recent });
  }

  let paneGetRevision: number | undefined;
  if (paneId) {
    const paneGet = await step("pane.get", () =>
      client.request<PaneInfoResult>("pane.get", { pane_id: paneId }),
    );
    if (paneGet) {
      save("herdr-pane-get.json", { id: "sb10", result: paneGet });
      paneGetRevision = paneGet.pane?.revision;
      console.log(
        "pane.get scroll (pane.scroll_changed fallback path):",
        JSON.stringify(paneGet.pane?.scroll ?? null),
      );
      console.log("pane.get revision:", paneGetRevision);
    }
  }

  const two = await twoRequestsOnOneConnection(path);
  console.log("responses to two pipelined requests (expect 1):", two.length);

  const keysAccepted: string[] = [];
  const keysRejected: string[] = [];
  let scratchTabId: string | null = null;
  let scratchPaneId: string | undefined;
  let scratchClosed = false;
  if (process.env.HERDR_SPIKE_KEYS === "1") {
    await step("key probe (own scratch tab)", async () => {
      const workspaceId =
        (snapshot?.snapshot.focused_workspace_id as string | null | undefined) ??
        (snapshot?.snapshot.workspaces as { workspace_id: string }[] | undefined)?.[0]
          ?.workspace_id;
      if (!workspaceId) throw new Error("no workspace available to create a scratch tab in");
      const created = await client.request<TabCreatedResult>("tab.create", {
        workspace_id: workspaceId,
        focus: false,
      });
      scratchTabId = created.tab?.tab_id ?? null;
      scratchPaneId = created.root_pane?.pane_id;
      console.log("key probe scratch tab created:", {
        tab_id: scratchTabId,
        pane_id: scratchPaneId,
      });
      try {
        if (!scratchPaneId) throw new Error("tab.create returned no root_pane.pane_id");
        // M-4: `enter` is only safe here because it happens to be the FIRST entry in `NAMED_KEYS`
        // (packages/protocol/src/keys.ts), so it fires before `up` ever recalls a shell history
        // line into this pane. That ordering is unrelated to this file and could change silently,
        // so send `ctrl+c` to the scratch pane after EVERY probed key (not just `up`/`down`) —
        // it clears whatever the previous key put on the line, so `enter` can never submit
        // anything but an empty prompt, independent of NAMED_KEYS' iteration order.
        for (const name of Object.keys(NAMED_KEYS) as NamedKey[]) {
          const candidate = HERDR_KEYS[name] ?? name.replace(/^ctrl-/, "ctrl+").replace(/-/g, "");
          try {
            await client.request("pane.send_keys", { pane_id: scratchPaneId, keys: [candidate] });
            keysAccepted.push(`${name} -> ${candidate}`);
          } catch (err) {
            keysRejected.push(
              `${name} -> ${candidate}: ${err instanceof Error ? err.message : err}`,
            );
          } finally {
            try {
              await client.request("pane.send_keys", {
                pane_id: scratchPaneId,
                keys: [HERDR_KEYS["ctrl-c"] ?? "ctrl+c"],
              });
            } catch (err) {
              failures.push({
                step: `key probe: ctrl+c after ${name}`,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
        }
      } finally {
        if (scratchTabId) {
          try {
            await client.request("tab.close", { tab_id: scratchTabId });
            scratchClosed = true;
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            failures.push({ step: "key probe: tab.close", error: message });
            console.error("!! failed to close key-probe scratch tab", scratchTabId, message);
          }
        }
      }
    });
    console.log(`keys accepted:\n  ${keysAccepted.join("\n  ")}`);
    console.log(`keys rejected:\n  ${keysRejected.join("\n  ")}`);
    console.log("key-probe scratch tab closed:", scratchClosed);
  }

  console.log("subscribing for 30 s — go make an agent ask you something…");
  let events = 0;
  let agentStatusSample: { event: string; data: Record<string, unknown>; atMs: number } | null =
    null;
  let scrollChangedSample: Record<string, unknown> | null = null;
  let layoutUpdatedSample: Record<string, unknown> | null = null;
  // `pane.copy_motion` does not exist -- change detection runs on
  // `pane_updated.pane.revision` instead, so this is what the spike now reports per pane.
  const revisionsByPane = new Map<string, number[]>();
  const subscribeStartedAt = performance.now();
  const stream = await step("events.subscribe (30s window)", () =>
    client.subscribe(
      [
        { type: "pane.created" },
        { type: "pane.closed" },
        { type: "pane.updated" },
        { type: "pane.focused" },
        { type: "pane.moved" },
        { type: "layout.updated" },
        ...panes.flatMap((p) => [
          { type: "pane.agent_status_changed", pane_id: p.pane_id },
          { type: "pane.scroll_changed", pane_id: p.pane_id },
        ]),
      ],
      {
        onEvent: (e) => {
          events++;
          const atMs = performance.now() - subscribeStartedAt;
          console.log(
            "EVENT",
            e.event,
            `(+${atMs.toFixed(0)}ms)`,
            JSON.stringify(e.data).slice(0, 200),
          );
          if (e.event.includes("agent_status_changed")) {
            agentStatusSample = { event: e.event, data: e.data, atMs };
            save("herdr-agent-status-event.json", { event: e.event, data: e.data });
          }
          if (e.event.includes("updated") && e.event.includes("pane")) {
            const pane = (e.data as { pane?: { pane_id?: string; revision?: number } }).pane;
            if (pane?.pane_id && typeof pane.revision === "number") {
              const seen = revisionsByPane.get(pane.pane_id) ?? [];
              seen.push(pane.revision);
              revisionsByPane.set(pane.pane_id, seen);
            }
          }
          if (!scrollChangedSample && e.event.includes("scroll_changed"))
            scrollChangedSample = e.data;
          if (!layoutUpdatedSample && e.event.includes("layout")) layoutUpdatedSample = e.data;
        },
        onEnd: (reason) => console.log("stream ended:", reason),
      },
    ),
  );
  if (stream) {
    await new Promise((r) => setTimeout(r, 30_000));
    stream.close();
    console.log(`captured ${events} events`);
  } else {
    console.log("event subscription failed; skipping the 30 s capture window (see failures[])");
  }

  // ---- Consolidated summary: local fixture review ----
  const lines: string[] = [];
  lines.push("");
  lines.push("========== HERDR FIXTURE REVIEW ==========");
  lines.push(
    `Q1 socket path: ${sanitize(path)} (exists=${socketExists}); HERDR_SESSION=${process.env.HERDR_SESSION ?? "(unset)"}; -client.sock sibling exists=${existsSync(clientSockSibling)}`,
  );
  lines.push(
    `Q2 ping: version=${pong?.version ?? "(no successful ping)"} protocol=${pong?.protocol ?? "?"} capabilities=${JSON.stringify(pong?.capabilities ?? null)} semverGate=${versionGate}`,
  );
  lines.push(`Q3 responses to two pipelined requests on one connection (expect 1): ${two.length}`);
  lines.push(
    `Q4 latencies: see "ping:"/"session.snapshot:"/"pane.read visible ansi:"/"pane.read recent ansi 200:" p50/max lines above -- every call costs one server tick (~100 ms).`,
  );
  lines.push(
    `Q5 pane.read visible ansi: CSI finals seen=[${csiFinals.join(" ")}] (expect only "m"); rows returned=${visibleRows ?? "(not captured)"}; padded-vs-trimmed and 256-colour/truecolor/CJK encoding require eyeballing the saved fixture (herdr-pane-read-visible.json).`,
  );
  lines.push(`Q6 every pane carries terminal_id: ${allHaveTerminalId}`);
  lines.push(
    `Q7 layout.updated: sample data=${JSON.stringify(layoutUpdatedSample)}; rect field names (from snapshot)=${firstLayout ? Object.keys(((firstLayout as LayoutRow).panes?.[0] as { rect?: object } | undefined)?.rect ?? {}) : "(no layouts)"}; compare against \`stty size\` manually to confirm units and whether dragging a divider fired it.`,
  );
  lines.push(
    `Q8 pane.scroll_changed: sample data=${JSON.stringify(scrollChangedSample)}; pane.get fallback scroll (see console "pane.get scroll" line above) confirms whether the fallback path is still needed.`,
  );
  lines.push(
    `Q9 revision (pane.copy_motion does not exist in this build -- change detection runs on ` +
      `pane_updated.pane.revision instead): revisions observed per pane during the 30s window: ` +
      `${JSON.stringify(Object.fromEntries(revisionsByPane))}; pane.get.revision for the primary ` +
      `pane: ${paneGetRevision ?? "(not captured)"}. Focus/idle behaviour requires manually ` +
      `repeating with the pane unfocused/idle.`,
  );
  lines.push(
    `Q10 agent state event: ${agentStatusSample ? `event="${(agentStatusSample as { event: string }).event}" data=${JSON.stringify((agentStatusSample as { data: Record<string, unknown> }).data)} arrived +${(agentStatusSample as { atMs: number }).atMs.toFixed(0)}ms into the subscription window` : "no pane.agent_status_changed event observed this run — re-run and make an agent block/unblock during the 30s window"}. Working->blocked and blocked->idle latency needs the human's own action timestamp compared to this line.`,
  );
  lines.push(
    `Q11 keys (HERDR_SPIKE_KEYS=1 only): ${process.env.HERDR_SPIKE_KEYS === "1" ? `accepted=[${keysAccepted.join(", ")}] rejected=[${keysRejected.join(", ")}]` : "not run this pass (set HERDR_SPIKE_KEYS=1)"}. Safety: ctrl+c is sent to the scratch pane immediately after EVERY probed key (not just up/down), so \`enter\` can never submit a recalled history line regardless of NAMED_KEYS' iteration order.`,
  );
  lines.push(
    "Q12 restart: not exercised by this script — human-run only (stop the herdr server with a subscription open and observe the socket file and connection EOF, per Step 3 item 12).",
  );
  lines.push(
    "Q13 sanitization: sanitize() replaced $HOME, the OS username, and the machine hostname (full and short form) with placeholders in every fixture written below; review each fixture for terminal content, repo names and any other stray identifiers before committing.",
  );
  lines.push(
    `Fixtures written (${writtenFixtures.length}): ${writtenFixtures.join(", ") || "(none)"}`,
  );
  lines.push(`Failures (${failures.length}): ${JSON.stringify(failures, null, 2)}`);
  lines.push("========== END SPIKE SUMMARY ==========");
  console.log(lines.join("\n"));
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
