import {
  authMessage,
  decodeEnvelope,
  fromBase64Url,
  hexToBytes,
  identityFromSeeds,
  type NotificationVectors,
  type Role,
  runNotificationVectorChecks,
  runVectorChecks,
  sha256,
  sign,
  type Vectors,
} from "@shellbell/protocol";
import { decodeSession, verifyAuthMessage } from "@shellbell/relay-core";
import notificationVectors from "../../protocol/test/notification-vectors.json";
import vectors from "../../protocol/test/vectors.json";
import { type Conn, type ScenarioClient, TestDevice } from "./client.js";
import session from "./fixtures/session-v1.json";
import bundle from "./fixtures/transcripts-v1.json";
import { bounded } from "./scenarios.js";

type Device = "host" | "phone";
type Step = { socket: string } & (
  | { op: "connect" }
  | {
      op: "authenticate";
      device: Device;
      role: Role;
      signRole?: Role;
      gateHex?: string;
      expected: Record<string, unknown>;
    }
  | { op: "gate-open"; gateHex: string; lifetimeMs: number }
  | { op: "send-ctrl"; device: Device; body: Record<string, unknown> }
  | { op: "expect-ctrl"; body: Record<string, unknown>; match?: "exact" | "subset" }
  | { op: "send-raw"; hex?: string; zeroBytes?: number }
  | {
      op: "send-frame" | "expect-frame";
      from: Device;
      to: Device;
      seq: number;
      nonceHex: string;
      ciphertextHex: string;
      noncanonical?: boolean;
      wireHex: string;
    }
  | { op: "expect-close"; code: number }
);
interface Transcript {
  id: string;
  setup: "bare" | "agent" | "paired";
  steps: Step[];
}
export const transcripts = bundle.scenarios as Transcript[];
type Equal = (actual: unknown, expected: unknown) => void;

/** Calls the protocol authority; no fixture-specific cryptography implementation. */
export function checkProtocolVectors(equal: Equal): void {
  for (const result of [
    ...runVectorChecks(vectors as Vectors),
    ...runNotificationVectorChecks(notificationVectors as NotificationVectors),
  ]) {
    equal({ name: result.name, ok: result.ok }, { name: result.name, ok: true });
  }
  for (const record of session.attachments) equal(decodeSession(record), { ...record, version: 1 });
  const auth = {
    type: "auth" as const,
    role: "agent" as const,
    fp: session.sender.fp,
    ed25519Pub: fromBase64Url(session.sender.ed25519Pub),
    sig: fromBase64Url(session.sender.signature),
    name: session.sender.name,
    appVersion: "test",
  };
  equal(
    verifyAuthMessage(auth, session.challenge.connId, fromBase64Url(session.challenge.nonce)),
    "ok",
  );
  const badSig = auth.sig.slice();
  badSig[0] = badSig[0]! ^ 1;
  equal(
    verifyAuthMessage(
      { ...auth, sig: badSig },
      session.challenge.connId,
      fromBase64Url(session.challenge.nonce),
    ),
    "bad-sig",
  );
}

export async function runTranscript(
  scenario: (typeof transcripts)[number],
  api: ScenarioClient,
  equal: Equal,
): Promise<void> {
  const devices = {
    host: new TestDevice(
      "synthetic-transcript-host",
      identityFromSeeds(
        hexToBytes(vectors.computer.edSeed),
        hexToBytes(vectors.computer.xSeed),
        "2026-01-01T00:00:00Z",
      ),
    ),
    phone: new TestDevice(
      "synthetic-transcript-phone",
      identityFromSeeds(
        hexToBytes(vectors.phone.edSeed),
        hexToBytes(vectors.phone.xSeed),
        "2026-01-01T00:00:00Z",
      ),
    ),
  };
  const sockets = new Map<string, Conn>();
  if (scenario.setup !== "bare") {
    const { agent } = await api.agentOnline(devices.host);
    sockets.set("agent", agent);
    if (scenario.setup === "paired") {
      await api.pair(agent, devices.host, devices.phone);
      const phone = await api.connect(devices.host.fp);
      equal((await api.authenticate(phone, devices.phone, "phone")).type, "auth-ok");
      equal((await agent.nextCtrl()).type, "phone-connected");
      sockets.set("phone", phone);
    }
  }
  const resolve = (value: unknown): unknown => {
    if (value === "$host") return devices.host.fp;
    if (value === "$phone") return devices.phone.fp;
    if (Array.isArray(value)) return value.map(resolve);
    if (value !== null && typeof value === "object") {
      if ("$hex" in value && typeof value.$hex === "string") return hexToBytes(value.$hex);
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolve(item)]));
    }
    return value;
  };
  const device = (name: string | undefined) => {
    if (name !== "host" && name !== "phone") throw new Error(`Unknown fixture device: ${name}`);
    return devices[name];
  };
  const frame = (step: Step) => {
    if (
      !(
        "from" in step &&
        "to" in step &&
        "nonceHex" in step &&
        "ciphertextHex" in step &&
        "seq" in step
      )
    )
      throw new Error("Invalid frame step");
    const expected = {
      v: 1,
      t: "e2e",
      from: device(step.from).fp,
      to: device(step.to).fp,
      seq: step.seq,
      body: { n: hexToBytes(step.nonceHex), c: hexToBytes(step.ciphertextHex) },
    };
    const raw = hexToBytes(step.wireHex);
    equal(decodeEnvelope(raw), expected);
    return raw;
  };
  for (const step of scenario.steps) {
    if (step.op === "connect") {
      if (sockets.has(step.socket)) throw new Error("Fixture reuses socket name");
      sockets.set(step.socket, await api.connect(devices.host.fp));
      continue;
    }
    const conn = sockets.get(step.socket);
    if (!conn) throw new Error(`Unknown fixture socket: ${step.socket}`);
    switch (step.op) {
      case "authenticate": {
        if (!("device" in step && "role" in step && "expected" in step))
          throw new Error("Invalid auth step");
        const dev = device(step.device);
        const ch = await conn.nextCtrl(bundle.stepTimeoutMs);
        if (ch.type !== "challenge") throw new Error("Expected challenge");
        conn.sendCtrl(dev.fp, {
          type: "auth",
          role: step.role,
          fp: dev.fp,
          ed25519Pub: dev.id.ed25519.pub,
          sig: sign(
            dev.id.ed25519.priv,
            authMessage(ch.connId, step.signRole ?? step.role, dev.fp, ch.nonce),
          ),
          name: dev.name,
          appVersion: "test",
          gate: step.gateHex === undefined ? undefined : hexToBytes(step.gateHex),
        });
        const actual = await conn.nextCtrl(bundle.stepTimeoutMs);
        // auth-ok contains runtime-generated fields; successful admission asserts type.
        equal(
          step.expected.type === "auth-ok" ? { type: actual.type } : actual,
          resolve(step.expected),
        );
        break;
      }
      case "gate-open":
        conn.sendCtrl(devices.host.fp, {
          type: "pairing-open",
          gateHash: sha256(hexToBytes(step.gateHex)),
          expiresAt: Date.now() + step.lifetimeMs,
        });
        break;
      case "send-ctrl":
        if (!("device" in step && "body" in step)) throw new Error("Invalid control step");
        conn.sendCtrl(device(step.device).fp, resolve(step.body));
        break;
      case "expect-ctrl": {
        if (!("body" in step)) throw new Error("Invalid control expectation");
        const actual = await conn.nextCtrl(bundle.stepTimeoutMs);
        const expected = resolve(step.body) as Record<string, unknown>;
        equal(
          "match" in step && step.match === "subset"
            ? Object.fromEntries(
                Object.keys(expected).map((key) => [
                  key,
                  (actual as unknown as Record<string, unknown>)[key],
                ]),
              )
            : actual,
          expected,
        );
        break;
      }
      case "send-raw":
        conn.sendRaw(
          step.hex !== undefined ? hexToBytes(step.hex) : new Uint8Array(step.zeroBytes!),
        );
        break;
      case "send-frame":
        conn.sendRaw(frame(step));
        break;
      case "expect-frame":
        equal(await conn.nextRaw(bundle.stepTimeoutMs), frame(step));
        break;
      case "expect-close":
        if (!("code" in step)) throw new Error("Invalid close expectation");
        equal((await bounded(conn.closed, scenario.id, bundle.stepTimeoutMs)).code, step.code);
        break;
      default:
        throw new Error("Unknown fixture operation");
    }
  }
}
