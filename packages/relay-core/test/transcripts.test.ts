import { describe, expect, it, vi } from "vitest";
import { type Conn, createScenarioClient } from "../test-support/client.js";
import session from "../test-support/fixtures/session-v1.json";
import fixtures from "../test-support/fixtures/transcripts-v1.json";
import { runTranscript } from "../test-support/transcripts.js";
import { validateSessionFixture, validateTranscripts } from "../test-support/transcripts-schema.js";

describe("language-neutral transcript schema", () => {
  it("uses the fixture timeout for close expectations", async () => {
    vi.useFakeTimers();
    const original = fixtures.stepTimeoutMs;
    fixtures.stepTimeoutMs = 25;
    const unused = () => {
      throw new Error("unused receive");
    };
    const conn: Conn = {
      nextRaw: unused,
      next: unused,
      nextCtrl: unused,
      sendCtrl: unused,
      sendEnvelope: unused,
      sendRaw: unused,
      close: () => {},
      closed: new Promise(() => {}),
    };
    let failure: unknown;
    const run = runTranscript(
      {
        id: "timeout-check",
        setup: "bare",
        steps: [
          { op: "connect", socket: "a" },
          { op: "expect-close", socket: "a", code: 1000 },
        ],
      },
      createScenarioClient(async () => conn),
      (actual, expected) => expect(actual).toEqual(expected),
    ).catch((error) => {
      failure = error;
    });
    try {
      await vi.advanceTimersByTimeAsync(25);
      expect(failure).toBeInstanceOf(Error);
      expect(String(failure)).toContain("timeout-check: timed out");
    } finally {
      await vi.runAllTimersAsync();
      await run;
      fixtures.stepTimeoutMs = original;
      vi.useRealTimers();
    }
  });
  it("validates the committed transcript bundle", () => {
    expect(() => validateTranscripts(fixtures)).not.toThrow();
  });
  it("validates every legacy session fixture attachment", () => {
    expect(() => validateSessionFixture(session)).not.toThrow();
    const invalid = structuredClone(session);
    invalid.attachments[0]!.leaseUntil = 1;
    expect(() => validateSessionFixture(invalid)).toThrow();
  });
  it.each([
    ["future version", { ...fixtures, v: 2 }],
    ["unknown field", { ...fixtures, secret: "never accepted" }],
    ["missing scenarios", { v: 1, synthetic: true }],
    [
      "invalid close",
      {
        ...fixtures,
        scenarios: [
          { id: "bad", setup: "bare", steps: [{ op: "expect-close", socket: "a", code: 999 }] },
        ],
      },
    ],
    [
      "unknown action",
      { ...fixtures, scenarios: [{ id: "bad", setup: "bare", steps: [{ op: "replay-input" }] }] },
    ],
  ])("rejects %s", (_name, fixture) => {
    expect(() => validateTranscripts(fixture)).toThrow();
  });
});
