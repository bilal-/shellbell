import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { classify, ITerm2Access } from "../src/backends/iterm2/access.js";
import { ITerm2AuthError } from "../src/backends/iterm2/auth.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function harness(
  options: {
    running?: boolean;
    api?: boolean;
    interactive?: boolean;
    assumeApproved?: boolean;
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "sb-iterm-access-"));
  dirs.push(dir);
  const asked: number[] = [];
  let answer: () => Promise<{ cookie: string; key: string }> = async () => ({
    cookie: "c",
    key: "k",
  });
  const state = { running: options.running ?? true, api: options.api ?? true };
  const make = (overrides: { assumeApproved?: boolean; interactive?: boolean } = {}) =>
    new ITerm2Access({
      recordPath: join(dir, "iterm2-access.json"),
      interactive: overrides.interactive ?? options.interactive,
      assumeApproved: overrides.assumeApproved ?? options.assumeApproved,
      socketPath: join(dir, "socket"),
      isRunning: async () => state.running,
      apiListening: async () => state.api,
      requestCookie: async () => {
        asked.push(1);
        return answer();
      },
    });
  const access = make();
  return {
    access,
    asked,
    state,
    make,
    dir,
    answer: (next: typeof answer) => {
      answer = next;
    },
    attempt: (target = access) =>
      target.cookieProvider(1000).then(
        () => "ok",
        () => target.issue,
      ),
  };
}

describe("ITerm2Access", () => {
  it("never asks macOS while iTerm2 is closed or its Python API is off", async () => {
    const h = harness({ running: false });
    expect(await h.attempt()).toBe("not-running");
    h.state.running = true;
    h.state.api = false;
    expect(await h.attempt()).toBe("api-off");
    expect(h.asked).toEqual([]);
  });

  it("waits for Connect iTerm2 before the first question, then remembers the approval", async () => {
    const h = harness();
    expect(await h.attempt()).toBe("needs-consent");
    expect(h.asked).toEqual([]);
    await h.access.connect(async () => {
      expect(h.access.connecting).toBe(true);
      expect(await h.attempt()).toBe("ok");
    });
    expect(h.access.issue).toBeUndefined();
    expect(JSON.parse(readFileSync(join(h.dir, "iterm2-access.json"), "utf8"))).toMatchObject({
      approved: true,
    });
    // A later run reconnects in the background without another click.
    const next = h.make();
    expect(await h.attempt(next)).toBe("ok");
    expect(h.asked).toHaveLength(2);
  });

  it("lets a person running Shellbell in a terminal be asked right away", async () => {
    const h = harness({ interactive: true });
    expect(await h.attempt()).toBe("ok");
  });

  it("keeps checking after macOS refuses, since a refusal never shows a dialog", async () => {
    const h = harness({ interactive: true });
    h.answer(async () => {
      throw new ITerm2AuthError(
        "Not authorized to send Apple events to iTerm2. (-1743)",
        "unknown",
      );
    });
    expect(await h.attempt()).toBe("automation-denied");
    h.answer(async () => ({ cookie: "c", key: "k" }));
    expect(await h.attempt()).toBe("ok");
  });

  it.each([
    ["iterm2-denied", new ITerm2AuthError("User canceled", "denied")],
    ["timed-out", new ITerm2AuthError("osascript timed out waiting for iTerm2", "unknown")],
  ])("stops asking in the background after %s until the next click", async (issue, error) => {
    const h = harness({ interactive: true });
    h.answer(async () => {
      throw error;
    });
    expect(await h.attempt()).toBe(issue);
    expect(await h.attempt()).toBe(issue);
    expect(h.asked).toHaveLength(1);
    h.answer(async () => ({ cookie: "c", key: "k" }));
    await h.access.connect(async () => {
      expect(await h.attempt()).toBe("ok");
    });
  });

  it("decides once whether an existing install counts as approved, so a later pairing does not", async () => {
    // A new install with no pairing: nothing approved, and that is written down.
    const h = harness({ assumeApproved: false });
    expect(await h.attempt()).toBe("needs-consent");
    // The next start finds a pairing made in the meantime; it still may not ask on its own.
    expect(await h.attempt(h.make({ assumeApproved: true }))).toBe("needs-consent");
    expect(h.asked).toEqual([]);
  });

  it("still stops asking in the background after a restart, until the next click", async () => {
    const h = harness({ assumeApproved: true });
    h.answer(async () => {
      throw new ITerm2AuthError("User canceled", "denied");
    });
    expect(await h.attempt()).toBe("iterm2-denied");
    const next = h.make({ assumeApproved: true });
    expect(await h.attempt(next)).toBe("iterm2-denied");
    expect(h.asked).toHaveLength(1);
    h.answer(async () => ({ cookie: "c", key: "k" }));
    await next.connect(async () => {
      expect(await h.attempt(next)).toBe("ok");
    });
    expect(await h.attempt(h.make())).toBe("ok");
  });

  it("asks once per click, even when the click retries after a refusal", async () => {
    const h = harness();
    h.answer(async () => {
      throw new ITerm2AuthError("User canceled", "denied");
    });
    await h.access.connect(async () => {
      expect(await h.attempt()).toBe("iterm2-denied");
      // The caller's reconnect loop tries again within the same click.
      expect(await h.attempt()).toBe("iterm2-denied");
    });
    expect(h.asked).toHaveLength(1);
  });

  it("names each failure", () => {
    expect(classify(new ITerm2AuthError("iTerm2 is too old (need 3.3+)", "too-old"))).toBe(
      "too-old",
    );
    expect(classify(new Error("socket"))).toBe("failed");
  });
});
