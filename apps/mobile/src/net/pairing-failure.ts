import { PairingError } from "./pairing";

/**
 * What the pair screen does next after a problem. `retry` reuses the scanned code, `save`
 * saves an approved pairing again without a new request, `open` goes to the computer already
 * paired, `camera` restarts the camera, and `rescan` returns to scanning.
 */
export type PairingAction = "rescan" | "retry" | "save" | "open" | "camera";

export interface PairingFailure {
  readonly title: string;
  readonly body?: string;
  readonly action: PairingAction;
  readonly label: string;
}

/** How many times one scanned code may be tried again before only a new code is offered. */
export const PAIRING_RETRIES = 2;

const NEW_CODE =
  "On your computer, open Shellbell and choose Pair Device, or run “shellbell pair” in Terminal. Then scan the new code.";
const NOT_ACTIVE: PairingFailure = {
  title: "This code is no longer active",
  body: NEW_CODE,
  action: "rescan",
  label: "Scan new code",
};
/** After the request reached the relay, the computer may still show it; a retry would race it. */
const MAY_BE_WAITING: PairingFailure = {
  title: "Pairing may still be waiting on your computer",
  body: "If your computer asks to approve this phone, decline it, then scan a new code.",
  action: "rescan",
  label: "Scan new code",
};

export const ALREADY_PAIRED: PairingFailure = {
  title: "You already paired this computer",
  action: "open",
  label: "Open it",
};
export const SAVE_FAILED: PairingFailure = {
  title: "Couldn't save this computer",
  body: "Your computer approved this phone. Saving again doesn't send a new request.",
  action: "save",
  label: "Try saving again",
};
export const CAMERA_FAILED: PairingFailure = {
  title: "The camera couldn't start",
  action: "camera",
  label: "Try again",
};

/** The one fitting next step for a failed pairing attempt. `tries` counts retries of this code. */
export function pairingFailure(error: unknown, tries: number): PairingFailure {
  const code = error instanceof PairingError ? error.code : "relay";
  const sent = error instanceof PairingError && error.sent;
  // A retry reuses the code; past the allowance, or once the code may be spent, scan anew.
  const retry = (failure: PairingFailure): PairingFailure =>
    tries < PAIRING_RETRIES ? failure : { ...failure, action: "rescan", label: "Scan new code" };
  switch (code) {
    case "bad-code":
    case "no-window":
    case "expired":
    case "bad-qr":
      return NOT_ACTIVE;
    case "no-agent":
      return retry({
        title: "Your computer isn't connected to Shellbell right now",
        body: "Check that Shellbell is running on your computer. This code works again until it expires, unless the computer restarts.",
        action: "retry",
        label: "Try again",
      });
    case "relay":
    case "timeout":
      return sent
        ? MAY_BE_WAITING
        : retry({
            title: "Couldn't reach the relay",
            body: "Check this phone's internet connection.",
            action: "retry",
            label: "Try again",
          });
    case "too-many":
      return {
        title: "Your computer can't take this request right now",
        body: "Decline any waiting request on your computer, or remove a phone you no longer use there.",
        action: "rescan",
        label: "Scan again",
      };
    case "unfinished":
      return {
        title: "Pairing didn't finish",
        body: "Remove this phone on your computer if it's listed there, then scan a new code.",
        action: "rescan",
        label: "Scan new code",
      };
    case "rate-limited":
      return {
        title: "Too many attempts",
        body: "Wait a minute, then scan a new code.",
        action: "rescan",
        label: "Scan new code",
      };
    case "declined":
      return { title: "Pairing wasn't approved", action: "rescan", label: "Scan again" };
    case "cancelled":
      return {
        title: "Stopped waiting on this phone",
        body: "Decline the request on your computer. If you already approved it, remove this phone there before pairing again.",
        action: "rescan",
        label: "Scan again",
      };
  }
}
