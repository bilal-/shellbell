import { describe, expect, it } from "vitest";
import { decodeSession } from "../src/session.js";
import fixture from "../test-support/fixtures/session-v1.json";

const legacy = {
  state: "unauth",
  connId: "synthetic-session-v1",
  nonce: "Hx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8",
  since: 1767225600000,
  fp: null,
  name: null,
  leaseUntil: 0,
};
const agent = {
  ...legacy,
  state: "agent",
  fp: "cc5gqlek2e2rhfy6rnliqgvlrp",
  name: "synthetic-fixture-host",
};

describe("decodeSession", () => {
  it.each(fixture.attachments)(
    "normalizes legacy $state without changing allowed fields",
    (input) => {
      expect(decodeSession(input)).toEqual({ ...input, version: 1 });
    },
  );

  it("preserves an explicit version and optional pairing used=false", () => {
    const input = { ...agent, version: 1, state: "pairing", used: false };
    expect(decodeSession(input)).toEqual(input);
  });

  it("returns a fresh record without mutating the attachment", () => {
    const input = Object.freeze({ ...legacy });
    expect(decodeSession(input)).not.toBe(input);
    expect(input).not.toHaveProperty("version");
  });

  it.each([0, 1, legacy.since - 1])(
    "preserves a phone lease %s even when already expired",
    (leaseUntil) => {
      expect(decodeSession({ ...agent, state: "phone", leaseUntil })).toEqual({
        version: 1,
        state: "phone",
        connId: "synthetic-session-v1",
        nonce: "Hx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8",
        since: 1767225600000,
        fp: "cc5gqlek2e2rhfy6rnliqgvlrp",
        name: "synthetic-fixture-host",
        leaseUntil,
      });
    },
  );

  it.each([
    null,
    undefined,
    [],
    "attachment",
    { ...legacy, state: "unknown" },
    { ...legacy, version: 99 },
    { ...legacy, version: "1" },
    { ...legacy, version: undefined },
    { ...legacy, connId: "" },
    { ...legacy, connId: "x".repeat(65) },
    { ...legacy, nonce: "!".repeat(43) },
    { ...legacy, nonce: "AA" },
    { ...legacy, nonce: `${legacy.nonce}=` },
    { ...legacy, nonce: `${legacy.nonce.slice(0, -1)}9` },
    { ...legacy, nonce: "A".repeat(44) },
    { ...legacy, since: NaN },
    { ...legacy, since: Infinity },
    { ...legacy, since: -1 },
    { ...legacy, leaseUntil: Infinity },
    { ...legacy, leaseUntil: -1 },
    { ...legacy, leaseUntil: "0" },
    { ...legacy, unexpected: true },
    { ...agent, fp: "not-a-fingerprint" },
    { ...agent, fp: "A".repeat(26) },
    { ...agent, name: "" },
    { ...agent, name: "x".repeat(65) },
    { ...agent, used: "yes" },
  ])("rejects malformed attachment %#", (input) => {
    expect(() => decodeSession(input)).toThrow();
  });

  it.each([
    { ...legacy, fp: agent.fp },
    { ...legacy, name: agent.name },
    { ...legacy, leaseUntil: 1 },
    { ...legacy, used: false },
    { ...agent, fp: null },
    { ...agent, name: null },
    { ...agent, leaseUntil: 1 },
    { ...agent, used: false },
    { ...agent, state: "phone", fp: null },
    { ...agent, state: "phone", name: null },
    { ...agent, state: "phone", used: true },
    { ...agent, state: "pairing", fp: null },
    { ...agent, state: "pairing", name: null },
    { ...agent, state: "pairing", leaseUntil: 1 },
  ])("rejects impossible session state %# instead of repairing identity", (input) => {
    expect(() => decodeSession(input)).toThrow();
  });

  it("rejects incomplete attachments", () => {
    const { name: _name, ...input } = legacy;
    expect(() => decodeSession(input)).toThrow();
  });
});
