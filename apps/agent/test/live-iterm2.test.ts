import { describe, expect, it } from "vitest";
import { ITerm2Backend } from "../src/backends/iterm2/backend.js";
import { ITerm2Client } from "../src/backends/iterm2/client.js";
import type { BackendEvent } from "../src/backends/types.js";
import { createLogger } from "../src/log.js";

/**
 * Drives a real, running iTerm2 over its Python API socket. Never run in CI; a contributor must
 * opt in explicitly via SHELLBELL_LIVE. Requires:
 *   - iTerm2 running with the Python API enabled (Settings → General → Magic → Enable Python API)
 *   - iTerm2's Shell Integration installed in the shell that runs the created tab -- only shell
 *     integration emits the command-start/command-end/prompt notifications this test asserts on
 *   - a human present the first time anything connects to the Python API: iTerm2 shows a one-time
 *     "Allow" consent dialog that blocks the socket until clicked, hence the generous 60 s budget
 *     below rather than the ~20 s a purely mechanical run would need.
 */
describe.skipIf(!process.env.SHELLBELL_LIVE)("live iTerm2", () => {
  it("creates a scratch tab, types a command, observes a command-end/prompt BackendEvent, and sees the echoed text", async () => {
    const log = createLogger({ stdout: true, verbose: true });
    const client = new ITerm2Client({ log });
    const b = new ITerm2Backend(client, log);
    try {
      await b.connect();

      // A scratch tab we create ourselves, never `sessions[0]` -- the brief itself flags
      // `sessions[0]` as "can be a TUI, not a shell" (flaky by construction). We don't need it
      // afterwards: it is left for the human running this test to close, or closed by hand.
      const sessionId = await b.createSession({ kind: "tab", backend: "iterm2" });

      const events: BackendEvent[] = [];
      const unsubscribe = b.on((e) => events.push(e));
      try {
        const token = `shellbell-live-${Date.now()}`;
        await b.sendText(sessionId, `echo ${token}\r`);

        // The event path, not just a polled getScreen: this is the exact code path where two
        // blocking pre-flight defects (wrong protobuf enum/message names) were only ever caught
        // by typecheck, never by a test that actually watched it.
        await expect
          .poll(
            () =>
              events.some(
                (e) =>
                  (e.type === "command-end" || e.type === "prompt") &&
                  "sessionId" in e &&
                  e.sessionId === sessionId,
              ),
            {
              timeout: 15_000,
              message:
                "no command-end/prompt BackendEvent for the typed command within 15s -- " +
                "requires iTerm2 Shell Integration to be installed in the shell that runs",
            },
          )
          .toBe(true);

        const screen = await b.getScreen(sessionId);
        const text = screen.lines.map((l) => l.r.map((r) => r.t).join("")).join("\n");
        // Assert a boolean with a message, never the raw text: a failure here must not dump
        // arbitrary terminal content into the test output.
        expect(text.includes(token), "typed command's echoed token was not found on screen").toBe(
          true,
        );
      } finally {
        unsubscribe();
      }
    } finally {
      await b.close();
    }
  }, 60_000);
});
