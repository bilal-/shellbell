import { bytesToHex, encodeEnvelope, hexToBytes } from "@shellbell/protocol";
import vectors from "../../protocol/test/vectors.json";
import fixtures from "../test-support/fixtures/transcripts-v1.json";

// Regenerate explicit wire examples using the protocol authority's encoder.
const fps: Record<string, string> = { host: vectors.computer.fp, phone: vectors.phone.fp };
for (const scenario of fixtures.scenarios) {
  for (const step of scenario.steps) {
    if (step.op !== "send-frame" && step.op !== "expect-frame") continue;
    if (!(step.from && step.to && step.seq !== undefined && step.nonceHex && step.ciphertextHex))
      throw new Error("Invalid frame fixture");
    let raw = encodeEnvelope({
      v: 1,
      t: "e2e",
      from: fps[step.from]!,
      to: fps[step.to]!,
      seq: step.seq,
      body: { n: hexToBytes(step.nonceHex), c: hexToBytes(step.ciphertextHex) },
    });
    if (step.noncanonical) {
      const noncanonical = new Uint8Array(raw.length + 1);
      noncanonical.set([0xb8, raw[0]! & 31]);
      noncanonical.set(raw.subarray(1), 2);
      raw = noncanonical;
    }
    Object.assign(step, { wireHex: bytesToHex(raw) });
  }
}
process.stdout.write(`${JSON.stringify(fixtures, null, 2)}\n`);
