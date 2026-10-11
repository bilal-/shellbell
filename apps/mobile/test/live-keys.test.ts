import { describe, expect, it, vi } from "vitest";
import { liveKeysIme } from "../src/input/imeProps";
import {
  BackspacePresses,
  LIVE_BATCH_MS,
  liveKeysDiff,
  TerminalBatcher,
} from "../src/input/liveKeys";

describe("Live keys edits", () => {
  it("types inserted characters and presses DEL for removed ones", () => {
    expect(liveKeysDiff("", "j")).toBe("j");
    expect(liveKeysDiff("j", "jj")).toBe("j");
    expect(liveKeysDiff("jj", "j")).toBe("\x7f");
    expect(liveKeysDiff("abc", "")).toBe("\x7f\x7f\x7f");
    // A keyboard that rewrites the tail sends the corrected keys, never a duplicate.
    expect(liveKeysDiff("teh", "the")).toBe("\x7f\x7fhe");
  });

  it("counts characters, not UTF-16 units, and types Enter as Return", () => {
    expect(liveKeysDiff("a😀", "a")).toBe("\x7f");
    expect(liveKeysDiff("a", "a\n")).toBe("\r");
    expect(liveKeysDiff("", "x\r\ny")).toBe("x\ry");
  });

  it("never offers a keyboard that predicts, corrects or composes", () => {
    for (const os of ["ios", "android"]) {
      expect(liveKeysIme(os)).toMatchObject({
        autoCorrect: false,
        spellCheck: false,
        autoComplete: "off",
        autoCapitalize: "none",
      });
    }
    expect(liveKeysIme("android").keyboardType).toBe("visible-password");
    expect(liveKeysIme("ios").keyboardType).toBe("ascii-capable");
  });
});

describe("Backspace pairing", () => {
  /** Every order of n key events (K) and n one-character deleting changes (C) from n characters. */
  function orders(n: number): string[] {
    const out: string[] = [];
    const walk = (k: number, c: number, seq: string) => {
      if (k === n && c === n) out.push(seq);
      if (k < n) walk(k + 1, c, `${seq}K`);
      if (c < n) walk(k, c + 1, `${seq}C`);
    };
    walk(0, 0, "");
    return out;
  }

  it.each([1, 2, 3, 4])("sends one DEL per press in every order of %i quick deletions", (n) => {
    for (const order of orders(n)) {
      const presses = new BackspacePresses();
      let characters = n;
      let dels = 0;
      for (const event of order) {
        if (event === "C") {
          characters--;
          dels++;
          presses.deleted();
        } else if (presses.key(characters)) dels++;
      }
      // Another press on the now empty field sends its own DEL.
      if (presses.key(characters)) dels++;
      expect({ order, dels }).toEqual({ order, dels: n + 1 });
    }
  });

  it("sends DEL for each press on an empty field and forgets unpaired changes on reset", () => {
    const presses = new BackspacePresses();
    expect([presses.key(0), presses.key(0), presses.key(0)]).toEqual([true, true, true]);
    presses.deleted();
    presses.reset();
    expect(presses.key(0)).toBe(true);
  });
});

describe("terminal batching", () => {
  it("sends keystrokes from one short window as one message", () => {
    vi.useFakeTimers();
    try {
      const send = vi.fn(() => true);
      const batch = new TerminalBatcher(send);
      batch.push("l");
      batch.push("s");
      expect(send).not.toHaveBeenCalled();
      vi.advanceTimersByTime(LIVE_BATCH_MS);
      expect(send).toHaveBeenCalledExactlyOnceWith("ls");
      batch.push("\r");
      vi.advanceTimersByTime(LIVE_BATCH_MS);
      expect(send.mock.calls).toEqual([["ls"], ["\r"]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("flushes on demand so a following key cannot overtake it, and only once", () => {
    vi.useFakeTimers();
    try {
      const log: string[] = [];
      const batch = new TerminalBatcher((data) => {
        log.push(data);
        return true;
      });
      batch.push(":w");
      batch.flush();
      log.push("<Esc>");
      vi.advanceTimersByTime(LIVE_BATCH_MS * 4);
      batch.flush();
      expect(log).toEqual([":w", "<Esc>"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
