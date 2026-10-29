import { authMessage, encodeEnvelope, sign } from "@shellbell/protocol";
import { expect, it, vi } from "vitest";
import { device, harness } from "../test-support/core-harness.js";

const checks = vi.hoisted(() => ({ count: 0 }));
vi.mock("../src/auth.js", async (load) => {
  const actual = await load<typeof import("../src/auth.js")>();
  return {
    ...actual,
    verifyAuthMessage: (...args: Parameters<typeof actual.verifyAuthMessage>) => {
      checks.count += 1;
      return actual.verifyAuthMessage(...args);
    },
  };
});

it("checks one signature for a burst of sign-in frames on one connection", async () => {
  const h = harness();
  await h.core.open("burst");
  const attacker = device("Phone");
  const body = {
    type: "auth",
    role: "phone",
    fp: attacker.fp,
    name: "p",
    ed25519Pub: attacker.id.ed25519.pub,
    sig: sign(
      attacker.id.ed25519.priv,
      authMessage("wrong", "phone", attacker.fp, new Uint8Array(32)),
    ),
    appVersion: "t",
  };
  const frame = encodeEnvelope({ v: 1, t: "ctrl", from: attacker.fp, seq: 0, body });
  checks.count = 0;
  // One socket read can carry the token bucket's whole burst before any handler runs.
  await Promise.all(Array.from({ length: 200 }, () => h.core.message("burst", frame)));
  expect(h.sessions.has("burst")).toBe(false);
  expect(checks.count).toBeLessThanOrEqual(2);
});

it("checks one signature per connection when a newer connection claims the same phone", async () => {
  const h = harness();
  await h.connect("agent");
  const phone = await h.pair();
  await h.core.open("burst");
  await h.core.open("newer");
  checks.count = 0;
  // Valid sign-ins queued on one connection, then the same phone signs in on another, so the
  // queued ones lose ownership instead of closing the socket on a bad signature.
  const burst = Array.from({ length: 100 }, () => h.auth("burst", phone, "phone"));
  const newer = h.auth("newer", phone, "phone");
  await Promise.all([...burst, newer]);
  expect(h.sessions.get("newer")?.state).toBe("phone");
  expect(checks.count).toBeLessThanOrEqual(4);
});
