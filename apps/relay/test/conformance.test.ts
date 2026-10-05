import { authMessage, fromBase64Url, identityFromSeeds, sign } from "@shellbell/protocol";
import { verifyAuthMessage } from "@shellbell/relay-core";
import { afterEach, describe, expect, it } from "vitest";
import {
  type Conn,
  createScenarioClient,
  TestDevice,
} from "../../../packages/relay-core/test-support/client.js";
import fixture from "../../../packages/relay-core/test-support/fixtures/session-v1.json";
import { bounded, relayScenarios } from "../../../packages/relay-core/test-support/scenarios.js";
import {
  checkProtocolVectors,
  runTranscript,
  transcripts,
} from "../../../packages/relay-core/test-support/transcripts.js";
import { connect } from "./helpers.js";

const sockets: Conn[] = [];
const api = createScenarioClient(async (fp) => {
  const conn = await connect(fp);
  sockets.push(conn);
  return conn;
});

afterEach(async () => {
  for (const conn of sockets) conn.close();
  await Promise.all(sockets.splice(0).map((conn) => bounded(conn.closed, "scenario cleanup")));
});

describe("portable relay conformance", () => {
  it("passes protocol-owned streaming/auth and notification vectors", () =>
    checkProtocolVectors((actual, expected) => expect(actual).toEqual(expected)));
  for (const transcript of transcripts) {
    it(`JSON transcript: ${transcript.id}`, () =>
      runTranscript(transcript, api, (actual, expected) => expect(actual).toEqual(expected)));
  }
  for (const scenario of relayScenarios) {
    it(scenario.name, () =>
      scenario.run(api, (actual, expected) => expect(actual).toEqual(expected)),
    );
  }

  it("authenticates the synthetic legacy sender signature", () => {
    expect(
      verifyAuthMessage(
        {
          type: "auth",
          role: "agent",
          fp: fixture.sender.fp,
          ed25519Pub: fromBase64Url(fixture.sender.ed25519Pub),
          sig: fromBase64Url(fixture.sender.signature),
          name: fixture.sender.name,
          appVersion: "test",
        },
        fixture.challenge.connId,
        fromBase64Url(fixture.challenge.nonce),
      ),
    ).toBe("ok");
  });

  it("fails authentication when a copied fixture sender signature is corrupted", () => {
    const copied = structuredClone(fixture);
    const sig = fromBase64Url(copied.sender.signature);
    sig[0] = (sig[0] ?? 0) ^ 1;
    expect(
      verifyAuthMessage(
        {
          type: "auth",
          role: "agent",
          fp: copied.sender.fp,
          ed25519Pub: fromBase64Url(copied.sender.ed25519Pub),
          sig,
          name: copied.sender.name,
          appVersion: "test",
        },
        copied.challenge.connId,
        fromBase64Url(copied.challenge.nonce),
      ),
    ).toBe("bad-sig");
  });

  it("returns auth-fail and closes for a corrupted live signature from the fixture sender", async () => {
    const sender = fixture.sender;
    const host = new TestDevice(
      sender.name,
      identityFromSeeds(
        new Uint8Array(sender.edSeed),
        new Uint8Array(sender.xSeed),
        sender.createdAt,
      ),
    );
    const conn = await api.connect(host.fp);
    const ch = await conn.nextCtrl();
    if (ch.type !== "challenge") throw new Error("expected challenge");
    const sig = sign(host.id.ed25519.priv, authMessage(ch.connId, "agent", host.fp, ch.nonce));
    sig[0] = (sig[0] ?? 0) ^ 1;
    conn.sendCtrl(host.fp, {
      type: "auth",
      role: "agent",
      fp: host.fp,
      ed25519Pub: host.id.ed25519.pub,
      sig,
      name: host.name,
      appVersion: "test",
    });
    expect(await conn.nextCtrl()).toEqual({ type: "auth-fail", reason: "bad-sig" });
    expect((await bounded(conn.closed, "bad signature close")).code).toBe(4001);
  });
});
