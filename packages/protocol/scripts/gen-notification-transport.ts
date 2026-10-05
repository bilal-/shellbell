// Public deterministic test identities/nonces only. Never imported by runtime code.
import { createCipheriv, hkdfSync } from "node:crypto";
import { writeFileSync } from "node:fs";
import { fingerprint, identityFromSeeds, toBase64Url } from "../src/index.js";

const identity = (seed: number) =>
  identityFromSeeds(
    new Uint8Array(32).fill(seed),
    new Uint8Array(32).fill(seed + 1),
    "2026-09-27T00:00:00.000Z",
  );
const computerFp = fingerprint(identity(11).ed25519.pub);
const phoneFp = fingerprint(identity(22).ed25519.pub);
const generation = toBase64Url(new Uint8Array(16).fill(1));
const key = Buffer.from(
  hkdfSync(
    "sha256",
    new Uint8Array(32).fill(3),
    "shellbell-notification-v1",
    JSON.stringify([computerFp, phoneFp, generation]),
    32,
  ),
);
const cases = [1, 2].map((index) => {
  const header = {
    computerFp,
    phoneFp,
    generation,
    sessionId: `tmux:qa-${index}`,
    eventId: toBase64Url(new Uint8Array(16).fill(index + 2)),
  };
  const payload = {
    ...header,
    context: {
      computerName: "Synthetic Mac",
      sessionLabel: `QA Terminal ${index}`,
      repository: "private-repository-qa",
      branch: "private-branch-qa",
      observedAt: 1000,
    },
    reason: "agent-blocked",
    issuedAt: 1000,
    expiresAt: 121000,
    sequence: "1",
  };
  const nonce = new Uint8Array(12).fill(index);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(
    Buffer.from(
      JSON.stringify([
        "shellbell-notification-v1",
        computerFp,
        phoneFp,
        generation,
        header.sessionId,
        header.eventId,
      ]),
    ),
  );
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload)),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return {
    payload,
    box: { ...header, nonce: toBase64Url(nonce), ciphertext: toBase64Url(ciphertext) },
  };
});
writeFileSync(
  new URL("../test/notification-transport-vectors.json", import.meta.url),
  `${JSON.stringify({ computerSeed: 11, phoneSeed: 22, key: key.toString("hex"), cases }, null, 2)}\n`,
);
