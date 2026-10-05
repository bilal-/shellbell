import { x25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it } from "vitest";
import { utf8 } from "../src/bytes.js";
import {
  createV2Handshake,
  decodeV2Frame,
  encodeV2Frame,
  encodeV2Prologue,
  type V2SessionContext,
  V2SessionContextSchema,
} from "../src/session-v2.js";

const phonePrivate = new Uint8Array(32).fill(3);
const computerPrivate = new Uint8Array(32).fill(7);
const pairKey = new Uint8Array(32).fill(11);

function relayContext(): V2SessionContext {
  return {
    route: "relay",
    computerFp: "a".repeat(26),
    phoneFp: "b".repeat(26),
    sessionId: new Uint8Array(16).fill(1),
    attemptId: new Uint8Array(16).fill(2),
    generation: Uint8Array.of(1, 0, 0, 0, 0, 0, 0, 0),
  };
}

function directContext(): V2SessionContext {
  return {
    ...relayContext(),
    route: "direct",
    phoneDtls: new Uint8Array(32).fill(13),
    computerDtls: new Uint8Array(32).fill(17),
  };
}

function peers(context: V2SessionContext = relayContext()) {
  const phone = createV2Handshake(context, "phone", {
    staticPrivate: phonePrivate,
    remoteStatic: x25519.getPublicKey(computerPrivate),
    pairKey,
  });
  const computer = createV2Handshake(context, "computer", {
    staticPrivate: computerPrivate,
    remoteStatic: x25519.getPublicKey(phonePrivate),
    pairKey,
  });
  computer.read(phone.write());
  phone.read(computer.write());
  return { phone: phone.finish(), computer: computer.finish() };
}

describe("v2 session wire binding", () => {
  it("requires canonical route context and binds both roles, generation, and DTLS certificates", () => {
    const relay = relayContext();
    expect(V2SessionContextSchema.parse(relay)).toEqual(relay);
    const direct: V2SessionContext = {
      ...relay,
      route: "direct",
      phoneDtls: new Uint8Array(32).fill(13),
      computerDtls: new Uint8Array(32).fill(17),
    };
    expect(encodeV2Prologue(direct)).not.toEqual(encodeV2Prologue(relay));
    expect(encodeV2Prologue({ ...direct, phoneDtls: new Uint8Array(32).fill(14) })).not.toEqual(
      encodeV2Prologue(direct),
    );
    expect(
      encodeV2Prologue({ ...relay, generation: Uint8Array.of(2, 0, 0, 0, 0, 0, 0, 0) }),
    ).not.toEqual(encodeV2Prologue(relay));
    expect(() =>
      V2SessionContextSchema.parse({ ...relay, phoneDtls: new Uint8Array(32) }),
    ).toThrow();
    expect(() =>
      V2SessionContextSchema.parse({ ...direct, computerDtls: new Uint8Array(31) }),
    ).toThrow();
    expect(() =>
      V2SessionContextSchema.parse({ ...relay, generation: new Uint8Array(8) }),
    ).toThrow();
    expect(() =>
      V2SessionContextSchema.parse({ ...relay, sessionId: new Uint8Array(16) }),
    ).toThrow();
  });

  it("requires confirmation from both peers before any terminal data", () => {
    const { phone, computer } = peers();
    expect(() => phone.seal(utf8("ls"))).toThrow(/confirm/i);
    const phoneConfirmation = phone.confirmation();
    expect(() => computer.open(phoneConfirmation)).toThrow(/data|confirm/i);
    // A confirmation is not terminal data; use the dedicated admission method.
    const computerConfirmation = computer.confirmation();
    computer.acceptConfirmation(phoneConfirmation);
    expect(computer.ready).toBe(true);
    expect(phone.ready).toBe(false);
    phone.acceptConfirmation(computerConfirmation);
    expect(phone.ready).toBe(true);
    const frame = phone.seal(utf8("ls"));
    expect(computer.open(decodeV2Frame(encodeV2Frame(frame)))).toEqual(utf8("ls"));
    expect(() => computer.open(frame)).toThrow(/replay|sequence/i);
    phone.close();
    computer.close();
  });

  it("requires the live remote DTLS certificate on a direct route", () => {
    const { phone, computer } = peers(directContext());
    computer.acceptConfirmation(phone.confirmation());
    phone.acceptConfirmation(computer.confirmation());
    expect(phone.ready).toBe(false);
    expect(computer.ready).toBe(false);
    phone.verifyRemoteDtls(new Uint8Array(32).fill(17));
    computer.verifyRemoteDtls(new Uint8Array(32).fill(13));
    expect(phone.ready).toBe(true);
    expect(computer.ready).toBe(true);
    expect(computer.open(phone.seal(utf8("direct")))).toEqual(utf8("direct"));
    const mismatch = peers(directContext());
    expect(() => mismatch.phone.verifyRemoteDtls(new Uint8Array(32).fill(99))).toThrow();
    expect(mismatch.phone.ready).toBe(false);
    expect(() => mismatch.phone.confirmation()).toThrow(/closed/i);
  });

  it("does not keep a half-open session after invalid key confirmation", () => {
    const { phone, computer } = peers();
    const confirm = phone.confirmation();
    expect(() =>
      computer.acceptConfirmation({ ...confirm, seq: Uint8Array.of(1, 0, 0, 0, 0, 0, 0, 0) }),
    ).toThrow();
    expect(() => computer.confirmation()).toThrow(/closed/i);
  });

  it("copies Node Buffer context IDs before the caller can mutate them", () => {
    const context = relayContext();
    context.sessionId = Buffer.from(context.sessionId);
    context.attemptId = Buffer.from(context.attemptId);
    context.generation = Buffer.from(context.generation);
    const { phone, computer } = peers(context);
    context.sessionId.fill(99);
    context.generation.fill(99);
    const confirm = phone.confirmation();
    expect(confirm.sessionId).toEqual(new Uint8Array(16).fill(1));
    expect(confirm.generation).toEqual(Uint8Array.of(1, 0, 0, 0, 0, 0, 0, 0));
    computer.acceptConfirmation(confirm);
  });

  it("rejects a mismatched paired key or prologue before confirmation", () => {
    const context = relayContext();
    const phone = createV2Handshake(context, "phone", {
      staticPrivate: phonePrivate,
      remoteStatic: x25519.getPublicKey(computerPrivate),
      pairKey,
    });
    const wrong = createV2Handshake(
      { ...context, attemptId: new Uint8Array(16).fill(9) },
      "computer",
      {
        staticPrivate: computerPrivate,
        remoteStatic: x25519.getPublicKey(phonePrivate),
        pairKey,
      },
    );
    expect(() => wrong.read(phone.write())).toThrow();
    expect(() => phone.finish()).toThrow();

    const pairedPhone = createV2Handshake(context, "phone", {
      staticPrivate: phonePrivate,
      remoteStatic: x25519.getPublicKey(computerPrivate),
      pairKey,
    });
    const wrongKeyComputer = createV2Handshake(context, "computer", {
      staticPrivate: computerPrivate,
      remoteStatic: x25519.getPublicKey(phonePrivate),
      pairKey: new Uint8Array(32).fill(12),
    });
    wrongKeyComputer.read(pairedPhone.write());
    expect(() => pairedPhone.read(wrongKeyComputer.write())).toThrow();

    const directPhone = createV2Handshake(directContext(), "phone", {
      staticPrivate: phonePrivate,
      remoteStatic: x25519.getPublicKey(computerPrivate),
      pairKey,
    });
    const otherDtls = { ...directContext(), computerDtls: new Uint8Array(32).fill(18) };
    const directComputer = createV2Handshake(otherDtls, "computer", {
      staticPrivate: computerPrivate,
      remoteStatic: x25519.getPublicKey(phonePrivate),
      pairKey,
    });
    expect(() => directComputer.read(directPhone.write())).toThrow();
  });

  it("closes the application session on a dropped encrypted frame", () => {
    const { phone, computer } = peers();
    computer.acceptConfirmation(phone.confirmation());
    phone.acceptConfirmation(computer.confirmation());
    const dropped = phone.seal(utf8("one"));
    const next = phone.seal(utf8("two"));
    expect(next.seq).not.toEqual(dropped.seq);
    expect(() => computer.open(next)).toThrow(/gap|resync/i);
    expect(computer.ready).toBe(false);
    expect(() => computer.open(dropped)).toThrow(/closed/i);
  });

  it("rejects replay and altered routing metadata without consuming a valid frame", () => {
    const { phone, computer } = peers();
    computer.acceptConfirmation(phone.confirmation());
    phone.acceptConfirmation(computer.confirmation());
    const first = phone.seal(utf8("one"));
    expect(computer.open(first)).toEqual(utf8("one"));
    expect(() => computer.open(first)).toThrow(/replay|sequence/i);
    const last = phone.seal(utf8("three"));
    expect(() =>
      computer.open({ ...last, generation: Uint8Array.of(9, 0, 0, 0, 0, 0, 0, 0) }),
    ).toThrow();
    expect(computer.open(last)).toEqual(utf8("three"));
    expect(() => phone.open(last)).toThrow();
  });

  it("never admits confirmation ciphertext as terminal data", () => {
    const { phone, computer } = peers();
    const phoneConfirmation = phone.confirmation();
    computer.acceptConfirmation(phoneConfirmation);
    phone.acceptConfirmation(computer.confirmation());
    expect(() => computer.open(phoneConfirmation)).toThrow(/type|sequence/i);
  });

  it("bounds decoded frames before parsing CBOR and rejects extra fields", () => {
    const { phone, computer } = peers();
    computer.acceptConfirmation(phone.confirmation());
    phone.acceptConfirmation(computer.confirmation());
    expect(() => phone.seal(new Uint8Array(60_001))).toThrow(/large/i);
    const largest = phone.seal(new Uint8Array(60_000));
    expect(encodeV2Frame(largest).length).toBeLessThan(64 * 1024);
    expect(computer.open(largest)).toEqual(new Uint8Array(60_000));
    const frame = phone.seal(utf8("ok"));
    expect(() => encodeV2Frame({ ...frame, unexpected: true } as typeof frame)).toThrow();
    expect(() => decodeV2Frame(new Uint8Array(61_001))).toThrow(/large/i);
    expect(computer.open(frame)).toEqual(utf8("ok"));
  });
});
