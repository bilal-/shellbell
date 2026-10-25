import { describe, expect, it } from "vitest";
import { PairingError } from "../src/net/pairing";
import { PAIRING_RETRIES, pairingFailure } from "../src/net/pairing-failure";

describe("pairing failures", () => {
  it("offers the same code again only before the request was sent, and only twice", () => {
    for (const code of ["relay", "timeout"] as const) {
      expect(pairingFailure(new PairingError(code, false), 0).action).toBe("retry");
      expect(pairingFailure(new PairingError(code, true), 0).action).toBe("rescan");
    }
    expect(pairingFailure(new PairingError("no-agent"), PAIRING_RETRIES - 1).action).toBe("retry");
    expect(pairingFailure(new PairingError("no-agent"), PAIRING_RETRIES)).toMatchObject({
      action: "rescan",
      label: "Scan new code",
    });
  });

  it("asks for a new code whenever this one can't work again", () => {
    for (const code of ["bad-code", "no-window", "expired", "unfinished", "rate-limited"] as const)
      expect(pairingFailure(new PairingError(code), 0)).toMatchObject({
        action: "rescan",
        label: "Scan new code",
      });
  });

  it("treats an unexpected error as a relay problem before sending", () => {
    expect(pairingFailure(new Error("boom"), 0)).toMatchObject({
      title: "Couldn't reach the relay",
      action: "retry",
    });
  });
});
