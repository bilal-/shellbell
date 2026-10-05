import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type Conn,
  createScenarioClient,
} from "../../../packages/relay-core/test-support/client.js";
import { bounded, relayScenarios } from "../../../packages/relay-core/test-support/scenarios.js";
import {
  checkProtocolVectors,
  runTranscript,
  transcripts,
} from "../../../packages/relay-core/test-support/transcripts.js";
import { type RunningRelay, startRelay } from "../src/server.js";
import { connect } from "./client.js";
import { temporaryDirectory } from "./helpers.js";

let relay: RunningRelay;
let directory: string;
const sockets: Conn[] = [];
const api = createScenarioClient(async (fp) => {
  const conn = await connect(relay.url, fp);
  sockets.push(conn);
  return conn;
});
beforeEach(async () => {
  directory = temporaryDirectory();
  relay = await startRelay({ dataDir: directory, port: 0, shutdownMs: 100 });
});
afterEach(async () => {
  for (const conn of sockets) conn.close();
  await Promise.all(sockets.splice(0).map((conn) => bounded(conn.closed, "scenario cleanup")));
  await relay.close();
  rmSync(directory, { recursive: true });
});
describe("actual Node relay conformance", () => {
  it("passes protocol-owned streaming/auth and notification vectors", () =>
    checkProtocolVectors((actual, expected) => expect(actual).toEqual(expected)));
  for (const transcript of transcripts) {
    it(`JSON transcript: ${transcript.id}`, () =>
      runTranscript(transcript, api, (actual, expected) => expect(actual).toEqual(expected)));
  }
  for (const scenario of relayScenarios)
    it(scenario.name, () =>
      scenario.run(api, (actual, expected) => expect(actual).toEqual(expected)),
    );
});
