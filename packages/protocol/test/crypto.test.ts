import { describe, expect, it } from "vitest";
import { utf8 } from "../src/bytes.js";
import {
  authMessage,
  deriveConnKey,
  derivePairKey,
  derivePskKey,
  fingerprint,
  frameAd,
  generateIdentity,
  helloAd,
  identityFromJson,
  identityFromSeeds,
  identityToJson,
  open,
  pairingAd,
  randomBytes,
  seal,
  sealWithNonce,
  sign,
  verify,
} from "../src/crypto.js";

describe("identity", () => {
  it("generates 32-byte keys and a 26-char fingerprint", () => {
    const id = generateIdentity();
    expect(id.ed25519.pub.length).toBe(32);
    expect(id.x25519.priv.length).toBe(32);
    expect(fingerprint(id.ed25519.pub)).toMatch(/^[a-z2-7]{26}$/);
  });
  it("is deterministic from seeds", () => {
    const a = identityFromSeeds(
      new Uint8Array(32).fill(1),
      new Uint8Array(32).fill(2),
      "2026-01-01T00:00:00Z",
    );
    const b = identityFromSeeds(
      new Uint8Array(32).fill(1),
      new Uint8Array(32).fill(2),
      "2026-01-01T00:00:00Z",
    );
    expect(a.ed25519.pub).toEqual(b.ed25519.pub);
    expect(a.x25519.pub).toEqual(b.x25519.pub);
  });
  it("round-trips through JSON", () => {
    const id = generateIdentity();
    const back = identityFromJson(JSON.parse(JSON.stringify(identityToJson(id))));
    expect(back.ed25519.priv).toEqual(id.ed25519.priv);
    expect(back.x25519.pub).toEqual(id.x25519.pub);
  });
  it("identityFromJson rejects incomplete JSON with ProtocolError", () => {
    expect(() => identityFromJson({ v: 1 })).toThrow(/malformed/);
  });
  it("identityFromJson rejects keys with wrong length", () => {
    const id = generateIdentity();
    const json = identityToJson(id);
    const invalidJson = {
      ...json,
      ed25519: {
        ...json.ed25519,
        pub: "AAAA", // 3 bytes when decoded
      },
    };
    expect(() => identityFromJson(invalidJson)).toThrow(/malformed/);
  });
  it("identityFromJson rejects bad base64url with ProtocolError", () => {
    const id = generateIdentity();
    const json = identityToJson(id);
    const invalidJson = {
      ...json,
      ed25519: {
        ...json.ed25519,
        pub: "not*valid",
      },
    };
    expect(() => identityFromJson(invalidJson)).toThrow(/malformed/);
  });
});

describe("signatures", () => {
  it("signs and verifies the auth message", () => {
    const id = generateIdentity();
    const fp = fingerprint(id.ed25519.pub);
    const nonce = randomBytes(32);
    const msg = authMessage("conn1", "phone", fp, nonce);
    const sig = sign(id.ed25519.priv, msg);
    expect(sig.length).toBe(64);
    expect(verify(id.ed25519.pub, msg, sig)).toBe(true);
    expect(verify(id.ed25519.pub, authMessage("conn2", "phone", fp, nonce), sig)).toBe(false);
  });
});

describe("aead", () => {
  it("seals and opens with matching ad; fails otherwise", () => {
    const key = randomBytes(32);
    const box = seal(key, utf8("secret"), "ad1");
    expect(box.n.length).toBe(24);
    expect(open(key, box, "ad1")).toEqual(utf8("secret"));
    expect(() => open(key, box, "ad2")).toThrow(/crypto/);
    expect(() => open(randomBytes(32), box, "ad1")).toThrow(/crypto/);
  });
  it("sealWithNonce is deterministic", () => {
    const key = new Uint8Array(32).fill(9);
    const n = new Uint8Array(24).fill(3);
    expect(sealWithNonce(key, n, utf8("x"), "ad")).toEqual(sealWithNonce(key, n, utf8("x"), "ad"));
  });
});

describe("key derivation", () => {
  const c = generateIdentity();
  const p = generateIdentity();
  const fpC = fingerprint(c.ed25519.pub);
  const fpP = fingerprint(p.ed25519.pub);
  const code = randomBytes(16);

  it("psk key depends on code and computer fp", () => {
    expect(derivePskKey(code, fpC)).toEqual(derivePskKey(code, fpC));
    expect(derivePskKey(code, fpC)).not.toEqual(derivePskKey(randomBytes(16), fpC));
    expect(derivePskKey(code, fpC)).not.toEqual(derivePskKey(code, fpP));
  });

  it("both sides derive the same K_pair; without the code they cannot", () => {
    const kc = derivePairKey(c.x25519.priv, p.x25519.pub, code, fpC, fpP);
    const kp = derivePairKey(p.x25519.priv, c.x25519.pub, code, fpC, fpP);
    expect(kc).toEqual(kp);
    expect(derivePairKey(c.x25519.priv, p.x25519.pub, randomBytes(16), fpC, fpP)).not.toEqual(kc);
  });

  it("K_conn differs per connection and old frames do not replay", () => {
    const kPair = derivePairKey(c.x25519.priv, p.x25519.pub, code, fpC, fpP);
    const a = deriveConnKey(kPair, randomBytes(16), randomBytes(16), fpC, fpP);
    const b = deriveConnKey(kPair, randomBytes(16), randomBytes(16), fpC, fpP);
    expect(a.kConn).not.toEqual(b.kConn);
    expect(a.connTag).toHaveLength(22);
    const frame = seal(a.kConn, utf8("rm -rf /"), frameAd(fpP, fpC, a.connTag, 1));
    expect(() => open(b.kConn, frame, frameAd(fpP, fpC, b.connTag, 1))).toThrow(/crypto/);
    expect(open(a.kConn, frame, frameAd(fpP, fpC, a.connTag, 1))).toEqual(utf8("rm -rf /"));
  });

  it("ad builders are the documented strings", () => {
    expect(frameAd("A", "B", "tag", 5)).toBe("1|A|B|tag|5");
    expect(helloAd("A", "B")).toBe("1|A|B|hello|0");
    expect(pairingAd("request", "C", "P")).toBe("pairing-request|C|P");
  });
});
