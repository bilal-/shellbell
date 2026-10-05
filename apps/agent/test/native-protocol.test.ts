import { describe, expect, it } from "vitest";
import * as protocol from "../src/native/protocol.js";

const { NativeRecordSchema, NativeRequestSchema } = protocol;

const id = "fdbbc2c2-3279-4b21-a599-750048df6c83";
const fp = "a".repeat(26);
const selection = {
  mode: "manual",
  stateDir: "/private/state",
  computerFp: fp,
  serviceInstance: id,
  bundlePath: "/Applications/Shellbell.app",
  bundleId: "sh.bilal.shellbell.host",
  agentVersion: "1.0.0",
  environment: {
    PATH: "/usr/bin:/bin",
    SHELLBELL_DIR: "/private/state",
    SHELLBELL_SERVICE_INSTANCE: id,
  },
};
const record = { v: 1, revision: id, selection, transition: null, recovery: null };
const expected = { revision: null, runtime: null };
const job = { registration: "not-registered", loaded: false, pid: null, bundlePath: null };
const status = {
  revision: null,
  selection: null,
  transition: null,
  recoveryAvailable: false,
  legacy: { installed: false, loaded: false, stateDir: null },
  manual: job,
  persistent: job,
  local: { kind: "absent", status: null },
};

describe("native admission", () => {
  it("admits desktop execution independently of legacy launchd modes", () => {
    expect(
      protocol.NativeSelectionSchema.safeParse({ ...selection, mode: "desktop" }).success,
    ).toBe(true);
    expect(protocol.NativeModeSchema.safeParse("desktop").success).toBe(false);
  });
  it("persists explicit legacy restart consent only on recovery transitions", () => {
    const transition = {
      id,
      action: "recover",
      phase: "prepared",
      source: selection,
      destination: null,
      recoveryId: null,
      restoreLegacy: { restartPrevious: false },
    };
    expect(protocol.NativeTransitionSchema.safeParse(transition).success).toBe(true);
    expect(
      protocol.NativeTransitionSchema.safeParse({ ...transition, action: "start" }).success,
    ).toBe(false);
    expect(
      protocol.NativeTransitionSchema.safeParse({
        ...transition,
        restoreLegacy: { restartPrevious: false, extra: true },
      }).success,
    ).toBe(false);
  });
  it.each(["/state\nnext", "/state\rnext", "/state\tnext", "/state\u007fnext"])(
    "rejects control characters in persisted paths",
    (path) => {
      expect(protocol.NativePathSchema.safeParse(path).success).toBe(false);
    },
  );
  it("validates a selection whose environment is assembled as the public Record contract", () => {
    const environment: Record<string, string> = { ...selection.environment };
    const chosen: protocol.NativeSelection = {
      ...selection,
      mode: "manual",
      bundleId: "sh.bilal.shellbell.host",
      environment,
    };
    const saved: protocol.NativeRecord = {
      v: 1,
      revision: id,
      selection: chosen,
      transition: null,
      recovery: null,
    };
    expect(NativeRecordSchema.safeParse(saved).success).toBe(true);
    const snapshot: protocol.NativeStatus = {
      ...protocol.NativeStatusSchema.parse(status),
      selection: chosen,
    };
    const response: protocol.NativeResponse = { v: 1, id: 1, ok: true, data: snapshot };
    expect(protocol.NativeResponseSchema.safeParse(response).success).toBe(true);
  });
  it("accepts a one MiB recovery but rejects larger, malformed and noncanonical base64", () => {
    const rawBase64 = Buffer.alloc(1024 * 1024, 65).toString("base64");
    const recovery = {
      id,
      definitionPath: "/private/legacy.plist",
      rawBase64,
      sha256: "b".repeat(64),
      wasLoaded: true,
      stateDir: "/private/state",
      computerFp: fp,
    };
    expect(protocol.NativeRecoverySchema.safeParse(recovery).success).toBe(true);
    for (const rawBase64 of [
      Buffer.alloc(1024 * 1024 + 1, 65).toString("base64"),
      "!invalid",
      "YQ",
      "YR==",
      "YQ==\n",
    ]) {
      expect(protocol.NativeRecoverySchema.safeParse({ ...recovery, rawBase64 }).success).toBe(
        false,
      );
    }
    expect(
      NativeRecordSchema.safeParse({
        ...record,
        recovery,
        transition: {
          id,
          action: "start",
          phase: "prepared",
          source: null,
          destination: null,
          recoveryId: id,
        },
      }).success,
    ).toBe(true);
  });
  it("accepts exact UTF-8 path bounds and rejects overlong or NUL-containing paths", () => {
    expect(protocol.NativePathSchema.safeParse(`/${"a".repeat(4095)}`).success).toBe(true);
    expect(protocol.NativePathSchema.safeParse(`/${"a".repeat(4096)}`).success).toBe(false);
    expect(protocol.NativePathSchema.safeParse("/a\0b").success).toBe(false);
  });
  it("keeps helper and local status objects strict at every nesting level", () => {
    expect(
      protocol.NativeHelperResponseSchema.safeParse({ v: 1, ok: true, status: "requires-approval" })
        .success,
    ).toBe(true);
    expect(
      protocol.NativeHelperResponseSchema.safeParse({ v: 1, ok: false, error: { code: "denied" } })
        .success,
    ).toBe(true);
    expect(
      protocol.NativeHelperResponseSchema.safeParse({
        v: 1,
        ok: false,
        error: { code: "denied", message: "secret" },
      }).success,
    ).toBe(false);
    const localStatus = {
      controlVersion: 1,
      process: {
        pid: 1,
        agentVersion: "1",
        computerFp: fp,
        stateDir: "/private/state",
        serviceInstance: null,
      },
      backends: [
        { name: "iterm2", connected: false },
        { name: "tmux", connected: false },
        { name: "herdr", connected: false },
      ],
      terminalReady: false,
      relayOnline: false,
      sessions: 0,
      phones: [],
      connected: [],
    };
    // Derive order from the protocol's published local-status contract, not an implementation helper.
    expect(
      protocol.NativeStatusSchema.safeParse({
        ...status,
        local: { kind: "verified", status: localStatus },
      }).success,
    ).toBe(true);
    expect(
      protocol.NativeStatusSchema.safeParse({
        ...status,
        local: {
          kind: "verified",
          status: { ...localStatus, process: { ...localStatus.process, stateDir: "/a\0b" } },
        },
      }).success,
    ).toBe(false);
    expect(
      protocol.NativeStatusSchema.safeParse({
        ...status,
        local: {
          kind: "verified",
          status: { ...localStatus, process: { ...localStatus.process, secret: true } },
        },
      }).success,
    ).toBe(false);
    expect(
      protocol.NativeStatusSchema.safeParse({
        ...status,
        local: {
          kind: "verified",
          status: {
            ...localStatus,
            phones: [{ phoneFp: fp, name: "Phone", lastSeenAt: null, secret: true }],
          },
        },
      }).success,
    ).toBe(false);
    expect(
      protocol.NativeResponseSchema.safeParse({
        v: 1,
        id: 1,
        ok: true,
        data: { secret: "not native data" },
      }).success,
    ).toBe(false);
  });
  it("rejects fields outside the native record contract", () => {
    expect(
      NativeRecordSchema.safeParse({
        v: 1,
        revision: "fdbbc2c2-3279-4b21-a599-750048df6c83",
        selection: null,
        transition: null,
        recovery: null,
        secret: "untrusted",
      }).success,
    ).toBe(false);
  });
  it("requires explicit consent before starting a service", () => {
    expect(
      NativeRequestSchema.safeParse({
        v: 1,
        id: 1,
        cmd: "service.start",
        args: {
          expect: { revision: null, runtime: null },
          mode: "persistent",
          consent: false,
          migrateLegacy: false,
        },
      }).success,
    ).toBe(false);
  });
  it("accepts every native command with its exact arguments", () => {
    const cases: [string, unknown?][] = [
      ["hello"],
      ["status"],
      ["settings.get"],
      ["diagnostics"],
      ["devices"],
      [
        "settings.set",
        {
          expect: expected,
          configRevision: "a".repeat(64),
          changes: [{ key: "name", value: "Mac" }],
        },
      ],
      ["service.start", { expect: expected, mode: "manual", consent: true, migrateLegacy: false }],
      ...["service.stop", "service.restart", "service.remove"].map(
        (cmd) => [cmd, { expect: expected }] as [string, unknown],
      ),
      [
        "service.recover",
        { expect: expected, action: "restore-legacy", restartPrevious: true, consent: true },
      ],
      ["devices.revoke", { expect: expected, phoneFp: fp }],
      ["pairing.open", { expect: expected }],
      ["pairing.close", { expect: expected, flowId: "a".repeat(22) }],
      [
        "pairing.confirm",
        {
          expect: expected,
          flowId: "a".repeat(22),
          challengeId: "b".repeat(22),
          phoneFp: fp,
          accept: true,
        },
      ],
    ];
    for (const [cmd, args] of cases) {
      const request = { v: 1, id: 1, cmd, ...(args === undefined ? {} : { args }) };
      expect(NativeRequestSchema.safeParse(request).success, cmd).toBe(true);
      expect(NativeRequestSchema.safeParse({ ...request, extra: true }).success, cmd).toBe(false);
      if (args !== undefined)
        expect(
          NativeRequestSchema.safeParse({ ...request, args: { ...(args as object), extra: true } })
            .success,
          cmd,
        ).toBe(false);
    }
  });
  it("rejects unsafe IDs, versions, unexpected arguments and nested runtime fields", () => {
    for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])
      expect(NativeRequestSchema.safeParse({ v: 1, id: value, cmd: "hello" }).success).toBe(false);
    expect(
      NativeRequestSchema.safeParse({ v: 1, id: Number.MAX_SAFE_INTEGER, cmd: "hello" }).success,
    ).toBe(true);
    expect(NativeRequestSchema.safeParse({ v: 2, id: 1, cmd: "hello" }).success).toBe(false);
    expect(NativeRequestSchema.safeParse({ v: 1, id: 1, cmd: "status", args: {} }).success).toBe(
      false,
    );
    expect(
      NativeRequestSchema.safeParse({
        v: 1,
        id: 1,
        cmd: "pairing.open",
        args: {
          expect: {
            revision: null,
            runtime: {
              pid: 1,
              agentVersion: "1",
              computerFp: fp,
              stateDir: "/state",
              serviceInstance: null,
              extra: true,
            },
          },
        },
      }).success,
    ).toBe(false);
  });
  it("bounds settings changes by unique keys and UTF-8 bytes", () => {
    const parse = (changes: unknown) =>
      NativeRequestSchema.safeParse({
        v: 1,
        id: 1,
        cmd: "settings.set",
        args: { expect: expected, configRevision: "b".repeat(64), changes },
      }).success;
    expect(parse([{ key: "name", value: "é".repeat(2048) }])).toBe(true);
    expect(parse([{ key: "name", value: `${"é".repeat(2048)}a` }])).toBe(false);
    expect(parse([])).toBe(false);
    expect(
      parse([
        { key: "name", value: "a" },
        { key: "name", value: "b" },
      ]),
    ).toBe(false);
    expect(parse([{ key: "unknown", value: "a" }])).toBe(false);
    expect(parse(Array.from({ length: 7 }, () => ({ key: "name", value: "a" })))).toBe(false);
  });
  it("restricts restartPrevious to restoration", () => {
    for (const action of ["continue", "discard-backup"])
      expect(
        NativeRequestSchema.safeParse({
          v: 1,
          id: 1,
          cmd: "service.recover",
          args: { expect: expected, action, restartPrevious: true, consent: true },
        }).success,
      ).toBe(false);
  });
  it("admits consistent selections and rejects unsafe paths and environment", () => {
    expect(NativeRecordSchema.safeParse(record).success).toBe(true);
    for (const changed of [
      { mode: "other" },
      { serviceInstance: "not-a-uuid" },
      { computerFp: "bad" },
      { bundleId: "other" },
      { stateDir: "relative" },
      { bundlePath: "/a\0b" },
      { stateDir: `/${"é".repeat(2048)}` },
      { environment: { ...selection.environment, SECRET: "key" } },
      { environment: { ...selection.environment, SHELLBELL_DIR: "/different" } },
      {
        environment: {
          ...selection.environment,
          SHELLBELL_SERVICE_INSTANCE: "bd109541-fd96-4078-9163-33934c5d6c9a",
        },
      },
      ...["", ":/bin", "/bin:", "relative:/bin"].map((PATH) => ({
        environment: { ...selection.environment, PATH },
      })),
    ])
      expect(
        NativeRecordSchema.safeParse({ ...record, selection: { ...selection, ...changed } })
          .success,
        JSON.stringify(changed),
      ).toBe(false);
  });
  it("requires transitions to reference the retained recovery and forbids recursive records", () => {
    const transition = {
      id,
      action: "start",
      phase: "prepared",
      source: null,
      destination: selection,
      recoveryId: id,
    };
    expect(NativeRecordSchema.safeParse({ ...record, transition }).success).toBe(false);
    expect(
      NativeRecordSchema.safeParse({ ...record, transition: { ...transition, recoveryId: null } })
        .success,
    ).toBe(true);
    expect(
      NativeRecordSchema.safeParse({
        ...record,
        transition: { ...transition, recoveryId: null, record },
      }).success,
    ).toBe(false);
  });
  it("validates every success data shape and content-free failure/event envelopes", () => {
    const schemas = protocol;
    const data = schemas.NativeDataSchemas;
    expect(data).toBeDefined();
    if (!data) return;
    const settings = {
      saved: {
        v: 1,
        relayUrl: "wss://relay.example",
        computerName: "Mac",
        accent: "blue",
        notifyMinCommandMs: 0,
        idleQuietMs: 1,
        idleMinActiveMs: 0,
      },
      savedRevision: "a".repeat(64),
      appliedRevision: null,
      applied: "not-running",
    };
    const values: Record<string, unknown> = {
      hello: {
        version: 1,
        agentVersion: "1",
        capabilities: ["status", "settings", "lifecycle", "pairing", "devices", "diagnostics"],
      },
      status,
      "settings.get": settings,
      "settings.set": settings,
      diagnostics: { checks: [{ name: "runtime", ok: true, severity: "pass", detail: "ready" }] },
      devices: [],
      "devices.revoke": { removed: true },
      "pairing.open": { flowId: "a".repeat(22), qrText: "private-qr", expiresAt: 1 },
      "pairing.close": {},
      "pairing.confirm": {},
    };
    for (const cmd of [
      "service.start",
      "service.stop",
      "service.restart",
      "service.remove",
      "service.recover",
    ])
      values[cmd] = status;
    for (const [cmd, value] of Object.entries(values))
      expect(data[cmd as keyof typeof data].safeParse(value).success, cmd).toBe(true);
    expect(data.status.safeParse({ ...status, recovery: { rawBase64: "secret" } }).success).toBe(
      false,
    );
    expect(
      data["settings.get"].safeParse({ ...settings, saved: { ...settings.saved, unknown: 1 } })
        .success,
    ).toBe(false);
    expect(data.status.safeParse({ ...status, manual: { ...job, unknown: 1 } }).success).toBe(
      false,
    );
    expect(
      data.diagnostics.safeParse({
        checks: Array.from({ length: 33 }, () => ({
          name: "x",
          ok: true,
          severity: "pass",
          detail: "ready",
        })),
      }).success,
    ).toBe(false);
    for (const [field, size] of [
      ["name", 64],
      ["detail", 1024],
      ["fix", 2048],
    ] as const) {
      const check = {
        name: "x",
        ok: true,
        severity: "pass",
        detail: "ready",
        [field]: "a".repeat(size),
      };
      expect(data.diagnostics.safeParse({ checks: [check] }).success).toBe(true);
      expect(
        data.diagnostics.safeParse({ checks: [{ ...check, [field]: "a".repeat(size + 1) }] })
          .success,
      ).toBe(false);
    }
    expect(
      schemas.NativeResponseSchema.safeParse({
        v: 1,
        id: 1,
        ok: false,
        error: { code: "conflict" },
      }).success,
    ).toBe(true);
    expect(
      schemas.NativeResponseSchema.safeParse({
        v: 1,
        id: 1,
        ok: false,
        error: { code: "conflict", message: "secret" },
      }).success,
    ).toBe(false);
    expect(schemas.NativeResponseSchema.safeParse({ v: 1, id: 1, ok: true }).success).toBe(false);
    expect(
      schemas.NativeEventSchema.safeParse({ v: 1, event: "pairing.closed", flowId: "a".repeat(22) })
        .success,
    ).toBe(true);
    expect(
      schemas.NativeEventSchema.safeParse({
        v: 1,
        event: "pairing.request",
        flowId: "a".repeat(22),
        challengeId: "b".repeat(22),
        phoneFp: fp,
        name: "Phone",
      }).success,
    ).toBe(true);
    expect(
      schemas.NativeEventSchema.safeParse({
        v: 1,
        event: "pairing.closed",
        flowId: "a".repeat(22),
        extra: 1,
      }).success,
    ).toBe(false);
  });
});
