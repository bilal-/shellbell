import { describe, expect, it } from "vitest";
import { fingerprint, generateIdentity, randomBytes } from "../src/crypto.js";
import { parseCtrl } from "../src/ctrl.js";
import {
  createPairRevocationV2,
  decodePairRevocationV2,
  encodePairRevocationV2,
  PairRevocationV2Schema,
  pairRevocationIdV2,
  verifyPairRevocationSignatureV2,
  verifyPairRevocationV2,
} from "../src/pair-revocation-v2.js";

describe("pair-scoped phone-signed revocation", () => {
  const computer = generateIdentity();
  const phone = generateIdentity();
  const computerFp = fingerprint(computer.ed25519.pub);
  const phoneFp = fingerprint(phone.ed25519.pub);
  const kPair = randomBytes(32);

  const signProof = () =>
    createPairRevocationV2({
      computerFp,
      phoneFp,
      kPair,
      phoneEd25519Priv: phone.ed25519.priv,
      phoneEd25519Pub: phone.ed25519.pub,
    });
  const trusted = () => ({
    computerFp,
    phoneFp,
    kPair,
    phoneEd25519Pub: phone.ed25519.pub,
  });

  it("authenticates the exact stored pairing", () => {
    const proof = signProof();
    expect(PairRevocationV2Schema.safeParse(proof).success).toBe(true);
    expect(verifyPairRevocationV2(proof, trusted())).toBe(true);
    expect(proof.pairId).toEqual(pairRevocationIdV2(kPair));
    expect(decodePairRevocationV2(encodePairRevocationV2(proof))).toEqual(proof);
    expect(parseCtrl({ type: "unpair", phoneFp, proof })).toMatchObject({ proof });
    expect(parseCtrl({ type: "unpaired", phoneFps: [phoneFp], proofs: [proof] })).toMatchObject({
      proofs: [proof],
    });
  });

  it("rejects another computer, phone, signing key, or changed pairing key", () => {
    const proof = signProof();
    expect(
      verifyPairRevocationV2(proof, {
        ...trusted(),
        computerFp: fingerprint(generateIdentity().ed25519.pub),
      }),
    ).toBe(false);
    expect(
      verifyPairRevocationV2(proof, {
        ...trusted(),
        phoneFp: fingerprint(generateIdentity().ed25519.pub),
      }),
    ).toBe(false);
    expect(
      verifyPairRevocationV2(proof, {
        ...trusted(),
        phoneEd25519Pub: generateIdentity().ed25519.pub,
      }),
    ).toBe(false);
    expect(verifyPairRevocationV2(proof, { ...trusted(), kPair: randomBytes(32) })).toBe(false);
  });

  it("rejects tampering and malformed proof before signature verification", () => {
    const proof = signProof();
    const signature = new Uint8Array(proof.signature);
    signature[0] = (signature[0] ?? 0) ^ 1;
    expect(verifyPairRevocationV2({ ...proof, signature }, trusted())).toBe(false);
    expect(verifyPairRevocationV2({ ...proof, pairId: new Uint8Array(31) }, trusted())).toBe(false);
    expect(verifyPairRevocationV2({ ...proof, signature: new Uint8Array(100000) }, trusted())).toBe(
      false,
    );
  });

  it("cannot replay an old proof against a fresh QR pairing with the same phone", () => {
    const oldProof = signProof();
    const fresh = randomBytes(32);
    expect(pairRevocationIdV2(fresh)).not.toEqual(oldProof.pairId);
    expect(verifyPairRevocationV2(oldProof, { ...trusted(), kPair: fresh })).toBe(false);
  });

  it("allows relay signature verification only when the stored pair ID is checked separately", () => {
    const proof = signProof();
    const publicTrust = { computerFp, phoneFp, phoneEd25519Pub: phone.ed25519.pub };
    expect(verifyPairRevocationSignatureV2(proof, publicTrust)).toBe(true);
    expect(
      verifyPairRevocationSignatureV2(proof, {
        ...publicTrust,
        phoneEd25519Pub: computer.ed25519.pub,
      }),
    ).toBe(false);
    expect(
      verifyPairRevocationSignatureV2({ ...proof, pairId: randomBytes(32) }, publicTrust),
    ).toBe(false);
    expect(
      verifyPairRevocationSignatureV2(proof, {
        ...publicTrust,
        computerFp: fingerprint(generateIdentity().ed25519.pub),
      }),
    ).toBe(false);
  });

  it("carries the pair ID in agent-owned relay pairing metadata", () => {
    const pairId = pairRevocationIdV2(kPair);
    const added = parseCtrl({
      type: "pairing-add",
      phoneFp,
      ed25519Pub: phone.ed25519.pub,
      name: "Phone",
      pairId,
    });
    expect(added.type === "pairing-add" && added.pairId).toEqual(pairId);
    const sync = parseCtrl({
      type: "pairings-sync",
      phones: [{ phoneFp, ed25519Pub: phone.ed25519.pub, name: "Phone", pairId }],
    });
    expect(sync.type === "pairings-sync" && sync.phones[0]?.pairId).toEqual(pairId);
  });
});
