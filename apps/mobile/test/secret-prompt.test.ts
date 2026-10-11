import { describe, expect, it } from "vitest";
import { cursorRowAsksForSecret } from "../src/input/secretPrompt";

const screen = (rows: string[], y: number) => ({
  cursor: { x: 0, y },
  lines: rows.map((t) => ({ r: t ? [{ t }] : [] })),
});

describe("password prompt detection", () => {
  it.each([
    "Password:",
    "[sudo] password for me: ",
    "Enter passphrase for key '/home/me/.ssh/id_ed25519': ",
    "me@host's password:",
    "Passcode:  ",
  ])("offers Secret input at %j", (prompt) => {
    expect(cursorRowAsksForSecret(screen(["$ sudo ls", prompt], 1))).toBe(true);
  });

  it.each(["$ echo password: done; ls", "passwords.txt", "Password changed.", "$ "])(
    "does not offer it at %j",
    (row) => {
      expect(cursorRowAsksForSecret(screen([row], 0))).toBe(false);
    },
  );

  it("only reads the cursor row", () => {
    expect(cursorRowAsksForSecret(screen(["Password:", "$ "], 1))).toBe(false);
    expect(cursorRowAsksForSecret(screen(["Password:"], -1))).toBe(false);
    expect(cursorRowAsksForSecret(undefined)).toBe(false);
  });
});
