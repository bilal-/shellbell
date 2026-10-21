import { describe, expect, it } from "vitest";
import { textScreen } from "../src/input/secretPrompt";
import { terminalInputFacts } from "../src/input/terminalFacts";
import type { MobileStreamSnapshot } from "../src/net/mobile-screen-stream";
import { VtReplayLog, type VtSeed } from "../src/terminal/vt-replay-log";
import type { VtStatus } from "../src/terminal/XtermView";

const status: VtStatus = {
  alternate: true,
  cursorLine: "Choice:",
  cursorY: 1,
  rows: ["Password:", "Choice:"],
};
function raw(cursor: VtSeed["cursor"], alternate: VtSeed["alternate"]) {
  const log = new VtReplayLog(
    {
      kind: "vt-seed",
      generation: 1,
      cols: 40,
      rows: 4,
      capture: "C".repeat(22),
      disposition: "initial",
      reason: "start",
      cursor,
      alternate,
    },
    new TextEncoder().encode("screen"),
  );
  const stream: MobileStreamSnapshot = {
    status: "live",
    historyStatus: "end",
    vt: { log, length: 0 },
    output: { state: "live" },
  };
  return { log, stream };
}

describe("source-backed terminal input facts", () => {
  it("keeps a prior secret hint until the current source supplies an observed screen", () => {
    const { log, stream } = raw("guessed", "unknown");
    expect(terminalInputFacts("herdr", stream, null, undefined, undefined, true).secret).toBe(true);
    log.apply(0);
    expect(
      terminalInputFacts(
        "herdr",
        stream,
        { ...status, rows: ["shell"], cursorLine: "shell" },
        undefined,
        undefined,
        true,
      ).secret,
    ).toBe(false);
    expect(
      terminalInputFacts(
        "herdr",
        { ...stream, output: { state: "ended" } },
        null,
        undefined,
        undefined,
        true,
      ).secret,
    ).toBe(false);
    log.dispose();
  });

  it("can render before the first screen without inventing a cursor", () => {
    expect(terminalInputFacts("tmux", undefined, null, undefined, true)).toEqual({
      cursorReal: false,
      alternateReal: true,
      secret: false,
    });
  });

  it.each(["unknown", "guessed"] as const)(
    "keeps secrets masked without using %s cursor or alternate facts for shortcuts",
    (fact) => {
      const { log, stream } = raw(fact, "unknown");
      log.apply(0);
      expect(terminalInputFacts("herdr", stream, status, undefined, true)).toEqual({
        cursorReal: false,
        alternateReal: false,
        secret: true,
      });
      log.dispose();
    },
  );

  it("requires the current renderer and a completed restore before interpreting native facts", () => {
    const { log, stream } = raw("real", "real");
    expect(terminalInputFacts("tmux", stream, status, undefined, true).cursorReal).toBe(false);
    log.apply(0);
    expect(terminalInputFacts("tmux", stream, null, undefined, true).alternateReal).toBe(false);
    expect(terminalInputFacts("tmux", stream, status, undefined, true)).toEqual({
      cursorReal: true,
      alternateReal: true,
      secret: false,
    });
    log.append(0, new TextEncoder().encode("tail"));
    log.apply(4);
    log.beginRender();
    log.render(0);
    expect(terminalInputFacts("tmux", stream, status, undefined, true).cursorReal).toBe(false);
    log.render(4);
    expect(terminalInputFacts("tmux", stream, status, undefined, true).cursorReal).toBe(true);
    expect(
      terminalInputFacts(
        "tmux",
        { ...stream, output: { state: "paused" } },
        status,
        undefined,
        true,
      ).cursorReal,
    ).toBe(false);
    log.dispose();
  });

  it("does not infer Herdr snapshot shortcuts while scanning visible rows for secrets", () => {
    const screen = textScreen(["Passphrase:", "idle"], 1);
    expect(terminalInputFacts("herdr", undefined, null, screen, true)).toEqual({
      cursorReal: false,
      alternateReal: false,
      secret: true,
    });
    expect(terminalInputFacts("tmux", undefined, null, screen, true)).toEqual({
      cursorReal: true,
      alternateReal: true,
      secret: false,
    });
  });
});
