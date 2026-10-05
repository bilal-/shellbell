import { describe, expect, it } from "vitest";
import * as control from "../src/control.js";

const runtime = {
  pid: 4242,
  agentVersion: "0.0.1-test",
  computerFp: "a".repeat(26),
  stateDir: "/tmp/shellbell-test-state",
  serviceInstance: null,
};

describe("control v2 protocol schemas", () => {
  it("accepts only a readonly configuration query and a strict lowercase digest result", () => {
    const query = { v: 2, id: 2, cmd: "status.config" };
    expect(control.ControlV2RequestSchema.safeParse(query).success).toBe(true);
    for (const extra of [{ args: {} }, { expect: runtime }])
      expect(control.ControlV2RequestSchema.safeParse({ ...query, ...extra }).success).toBe(false);
    const schema = control.ControlV2DataSchemas["status.config"];
    expect(schema.safeParse({ revision: "a".repeat(64) }).success).toBe(true);
    for (const data of [
      { revision: "A".repeat(64) },
      { revision: "a".repeat(63) },
      { revision: "z".repeat(64) },
      { revision: "a".repeat(64), extra: true },
    ])
      expect(schema.safeParse(data).success).toBe(false);
  });
  it("accepts a strict hello and rejects an undeclared request field", () => {
    // Removing strict request validation lets an accidental client/server contract drift through.
    expect(control.ControlV2RequestSchema).toBeDefined();
    expect(control.ControlV2RequestSchema.safeParse({ v: 2, id: 1, cmd: "hello" }).success).toBe(
      true,
    );
    expect(
      control.ControlV2RequestSchema.safeParse({
        v: 2,
        id: 1,
        cmd: "hello",
        extra: true,
      }).success,
    ).toBe(false);
  });

  it("requires the exact observed runtime tuple on mutations", () => {
    // Removing an ownership field must make a mutation invalid before dispatch.
    expect(
      control.ControlV2RequestSchema.safeParse({
        v: 2,
        id: 2,
        cmd: "devices.revoke",
        expect: { ...runtime, computerFp: undefined },
        args: { phoneFp: "b".repeat(26) },
      }).success,
    ).toBe(false);
    expect(
      control.ControlV2RequestSchema.safeParse({
        v: 2,
        id: 2,
        cmd: "devices.revoke",
        expect: runtime,
        args: { phoneFp: "b".repeat(26) },
      }).success,
    ).toBe(true);
  });

  it("keeps response envelopes strict while command schemas validate success data", () => {
    // Allowing an unknown error property leaks an undocumented wire field.
    expect(
      control.ControlV2ResponseSchema.safeParse({
        v: 2,
        id: 2,
        ok: false,
        error: { code: "runtime-mismatch", detail: "not for clients" },
      }).success,
    ).toBe(false);
    expect(
      control.ControlV2DataSchemas["devices.revoke"].safeParse({ removed: true }).success,
    ).toBe(true);
    expect(
      control.ControlV2DataSchemas["devices.revoke"].safeParse({ removed: true, extra: 1 }).success,
    ).toBe(false);
  });

  it("defines every command, pairing result, and event with bounded strict values", () => {
    // Missing a command discriminator or accepting a short flow ID changes the wire contract.
    const flowId = "A".repeat(22);
    const requests = [
      { v: 2, id: 2, cmd: "status" },
      { v: 2, id: 3, cmd: "devices" },
      { v: 2, id: 4, cmd: "pairing.open", expect: runtime },
      { v: 2, id: 5, cmd: "pairing.close", expect: runtime, args: { flowId } },
      {
        v: 2,
        id: 6,
        cmd: "pairing.confirm",
        expect: runtime,
        args: { flowId, challengeId: "B".repeat(22), phoneFp: "b".repeat(26), accept: true },
      },
    ];
    for (const request of requests)
      expect(control.ControlV2RequestSchema.safeParse(request).success).toBe(true);
    expect(control.ControlV2RequestSchema.safeParse({ v: 2, id: 0, cmd: "status" }).success).toBe(
      false,
    );
    expect(
      control.ControlPairingOpenSchema.safeParse({
        flowId,
        qrText: "pairing qr",
        expiresAt: 1,
      }).success,
    ).toBe(true);
    expect(
      control.ControlV2EventSchema.safeParse({
        v: 2,
        event: "pairing.request",
        flowId,
        challengeId: "B".repeat(22),
        phoneFp: "b".repeat(26),
        name: "Phone",
      }).success,
    ).toBe(true);
    expect(
      control.ControlV2EventSchema.safeParse({ v: 2, event: "pairing.closed", flowId, extra: true })
        .success,
    ).toBe(false);
  });

  it("reuses strict local-status semantics for status data", () => {
    // Allowing an extra nested process field makes successful status data less strict than v2.
    const status = {
      controlVersion: 1,
      process: runtime,
      backends: [
        { name: "iterm2", connected: true },
        { name: "tmux", connected: false },
        { name: "herdr", connected: false },
      ],
      terminalReady: true,
      relayOnline: true,
      sessions: 1,
      phones: [{ phoneFp: "b".repeat(26), name: "Phone", lastSeenAt: null }],
      connected: [{ phoneFp: "b".repeat(26), name: "Phone", viewed: null }],
    };
    expect(control.ControlV2DataSchemas.status.safeParse(status).success).toBe(true);
    expect(
      control.ControlV2DataSchemas.status.safeParse({
        ...status,
        process: { ...runtime, leaked: "unrecognized" },
      }).success,
    ).toBe(false);
  });

  it("validates every command result schema and rejects unknown result fields", () => {
    // Leaving one result as an unvalidated object would let server/client contracts drift.
    const flowId = "A".repeat(22);
    expect(
      control.ControlV2DataSchemas.hello.safeParse({
        version: 2,
        runtime,
        capabilities: ["status", "devices", "pairing", "revoke"],
      }).success,
    ).toBe(true);
    expect(
      control.ControlV2DataSchemas.devices.safeParse([
        { phoneFp: "b".repeat(26), name: "Phone", lastSeenAt: null },
      ]).success,
    ).toBe(true);
    expect(control.ControlV2DataSchemas["pairing.close"].safeParse({}).success).toBe(true);
    expect(control.ControlV2DataSchemas["pairing.confirm"].safeParse({}).success).toBe(true);
    expect(
      control.ControlV2DataSchemas["pairing.open"].safeParse({
        flowId,
        qrText: "qr",
        expiresAt: 1,
        extra: true,
      }).success,
    ).toBe(false);
    expect(control.ControlV2DataSchemas["pairing.close"].safeParse({ extra: true }).success).toBe(
      false,
    );
  });

  it("rejects malformed IDs, runtime tuples, and unknown fields across v2 envelopes", () => {
    // Relaxing any envelope branch permits protocol switching or undeclared mutation arguments.
    const flowId = "A".repeat(22);
    for (const request of [
      { v: 2, id: -1, cmd: "hello" },
      { v: 2, id: 1.5, cmd: "status" },
      { v: 2, id: Number.MAX_SAFE_INTEGER + 1, cmd: "devices" },
      { v: 2, id: 2, cmd: "pairing.open", expect: { ...runtime, extra: true } },
      {
        v: 2,
        id: 3,
        cmd: "pairing.close",
        expect: runtime,
        args: { flowId, extra: true },
      },
    ])
      expect(control.ControlV2RequestSchema.safeParse(request).success).toBe(false);
    expect(
      control.ControlV2ResponseSchema.safeParse({
        v: 2,
        id: 1,
        ok: true,
        data: {},
        extra: true,
      }).success,
    ).toBe(false);
    expect(
      control.ControlV2ResponseSchema.safeParse({
        v: 2,
        id: 1,
        ok: false,
        error: { code: "unlisted" },
      }).success,
    ).toBe(false);
    expect(
      control.ControlV2EventSchema.safeParse({ v: 2, event: "pairing.closed", flowId }).success,
    ).toBe(true);
  });

  it("rejects unknown fields for every success-result contract", () => {
    // A permissive result branch would make one native command silently diverge from its schema.
    const flowId = "A".repeat(22);
    const status = {
      controlVersion: 1,
      process: runtime,
      backends: [
        { name: "iterm2", connected: true },
        { name: "tmux", connected: false },
        { name: "herdr", connected: false },
      ],
      terminalReady: true,
      relayOnline: true,
      sessions: 0,
      phones: [],
      connected: [],
    };
    const unknown = "not-on-the-wire";
    expect(
      control.ControlV2DataSchemas.hello.safeParse({
        version: 2,
        runtime,
        capabilities: ["status", "devices", "pairing", "revoke"],
        unknown,
      }).success,
    ).toBe(false);
    expect(control.ControlV2DataSchemas.status.safeParse({ ...status, unknown }).success).toBe(
      false,
    );
    expect(
      control.ControlV2DataSchemas.devices.safeParse([
        { phoneFp: "b".repeat(26), name: "Phone", lastSeenAt: null, unknown },
      ]).success,
    ).toBe(false);
    expect(
      control.ControlV2DataSchemas["devices.revoke"].safeParse({ removed: true, unknown }).success,
    ).toBe(false);
    expect(
      control.ControlV2DataSchemas["pairing.open"].safeParse({
        flowId,
        qrText: "qr",
        expiresAt: 1,
        unknown,
      }).success,
    ).toBe(false);
    expect(control.ControlV2DataSchemas["pairing.close"].safeParse({ unknown }).success).toBe(
      false,
    );
    expect(control.ControlV2DataSchemas["pairing.confirm"].safeParse({ unknown }).success).toBe(
      false,
    );
  });

  it("rejects undeclared and malformed pairing event fields", () => {
    // Event schemas must not let an uncorrelated pairing request reach a native consent view.
    const flowId = "A".repeat(22);
    const request = {
      v: 2,
      event: "pairing.request",
      flowId,
      challengeId: "B".repeat(22),
      phoneFp: "b".repeat(26),
      name: "Phone",
    };
    expect(
      control.ControlV2EventSchema.safeParse({
        v: 2,
        event: "pairing.closed",
        flowId,
        unknown: true,
      }).success,
    ).toBe(false);
    expect(control.ControlV2EventSchema.safeParse({ ...request, unknown: true }).success).toBe(
      false,
    );
    expect(
      control.ControlV2EventSchema.safeParse({ ...request, challengeId: "too-short" }).success,
    ).toBe(false);
    expect(control.ControlV2EventSchema.safeParse({ ...request, name: "" }).success).toBe(false);
  });
});
