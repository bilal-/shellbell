import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HerdrBackend } from "../src/backends/herdr/backend.js";
import { HerdrClient } from "../src/backends/herdr/client.js";
import type { SessionSnapshotResult, TabCreatedResult } from "../src/backends/herdr/types.js";
import type { BackendEvent } from "../src/backends/types.js";
import { createLogger } from "../src/log.js";

// Same gate shape as the shipped `test/live-iterm2.test.ts` (`describe.skipIf(!process.env.…)`),
// so one `SHELLBELL_LIVE=1` opts into both live suites.
const live = Boolean(process.env.SHELLBELL_LIVE);
const log = createLogger({ stdout: true, verbose: true });

describe.skipIf(!live)("live herdr", () => {
  const client = new HerdrClient({ log });
  let backend: HerdrBackend | null = null;
  let tabId: string | null = null;
  let scratchTerminalId: string | null = null;

  beforeAll(async () => {
    // Our own tab, never the operator's agent pane, and never focused.
    const snap = await client.request<SessionSnapshotResult>("session.snapshot", {});
    const workspaceId =
      snap.snapshot.focused_workspace_id ?? snap.snapshot.workspaces[0]?.workspace_id;
    if (!workspaceId) throw new Error("herdr has no workspace");
    const created = await client.request<TabCreatedResult>("tab.create", {
      workspace_id: workspaceId,
      focus: false,
    });
    tabId = created.tab?.tab_id ?? null;
    scratchTerminalId = created.root_pane.terminal_id;
  }, 20_000);

  afterAll(async () => {
    // Always: a failed assertion must not leave a tab or a subscription behind.
    try {
      await backend?.close();
    } finally {
      if (tabId) await client.request("tab.close", { tab_id: tabId }).catch(() => undefined);
    }
  }, 20_000);

  it("lists the scratch pane, reads a styled screen, submits a line and sees the change", async () => {
    const b = new HerdrBackend({ client, log });
    backend = b;
    await b.connect();
    expect(b.isConnected).toBe(true);

    const sessions = await b.listSessions();
    const scratch = sessions.find((s) => s.id === scratchTerminalId);
    expect(scratch, "the scratch pane must be in listSessions").toBeTruthy();
    const id = (scratch as (typeof sessions)[number]).id;

    const before = await b.getScreen(id);
    expect(before.rows).toBe((scratch as (typeof sessions)[number]).rows);
    expect(before.lines).toHaveLength(before.rows);
    expect(before.cursor.x).toBeLessThan(before.cols);

    const events: BackendEvent[] = [];
    b.on((e) => events.push(e));
    // Change detection is event-driven for every pane, watched or not: a
    // `pane_updated` event with a new `revision` fires `screen-changed` on its own.
    await b.sendText(id, "echo shellbell-herdr-live-ok\r");
    await new Promise((r) => setTimeout(r, 2500));

    expect(events.some((e) => e.type === "screen-changed" && e.sessionId === id)).toBe(true);
    const after = await b.getScreen(id);
    const text = after.lines.map((l) => l.r.map((r) => r.t).join("")).join("\n");
    // Assert a boolean with a message, never the raw text: a failure here must not dump
    // arbitrary terminal content into the test output (same rule as live-iterm2.test.ts).
    expect(text.includes("shellbell-herdr-live-ok"), "echoed token was not found on screen").toBe(
      true,
    );

    const history = await b.getHistory(id, after.scrollbackTotal, 20);
    expect(Array.isArray(history.lines)).toBe(true);
  }, 40_000);
});
