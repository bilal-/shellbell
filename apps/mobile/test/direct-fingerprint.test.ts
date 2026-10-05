import { describe, expect, it } from "vitest";
import { verifyRemoteDtlsFingerprint } from "../src/net/direct/fingerprint.js";

const EXPECTED =
  "A3:5E:9A:13:1F:BD:DB:FE:7C:00:4A:5D:71:41:C2:98:D6:8D:B5:9E:A1:71:69:9C:78:37:7C:BA:60:B7:CD:D7";
const OTHER =
  "B3:5E:9A:13:1F:BD:DB:FE:7C:00:4A:5D:71:41:C2:98:D6:8D:B5:9E:A1:71:69:9C:78:37:7C:BA:60:B7:CD:D7";

const stats = (remoteFingerprint = EXPECTED) =>
  new Map<string, unknown>([
    [
      "transport-id",
      {
        id: "transport-id",
        type: "transport",
        dtlsState: "connected",
        remoteCertificateId: "remote-cert",
      },
    ],
    [
      "remote-cert",
      {
        id: "remote-cert",
        type: "certificate",
        fingerprintAlgorithm: "sha-256",
        fingerprint: remoteFingerprint,
      },
    ],
    [
      "local-cert",
      {
        id: "local-cert",
        type: "certificate",
        fingerprintAlgorithm: "sha-256",
        fingerprint: OTHER,
      },
    ],
  ]);

describe("live DTLS certificate binding", () => {
  it("accepts the remote certificate referenced by the active native transport", () => {
    expect(
      verifyRemoteDtlsFingerprint(stats(), { algorithm: "sha-256", value: EXPECTED.toLowerCase() }),
    ).toBe(EXPECTED);
  });

  it("rejects a mismatched referenced remote certificate even if another certificate matches", () => {
    const report = stats(OTHER);
    report.set("decoy", {
      id: "decoy",
      type: "certificate",
      fingerprintAlgorithm: "sha-256",
      fingerprint: EXPECTED,
    });
    expect(() =>
      verifyRemoteDtlsFingerprint(report, { algorithm: "sha-256", value: EXPECTED }),
    ).toThrow(/mismatch/i);
  });

  it("fails closed without a transport-linked remote certificate", () => {
    expect(() =>
      verifyRemoteDtlsFingerprint(new Map(), { algorithm: "sha-256", value: EXPECTED }),
    ).toThrow(/remote certificate/i);
    const report = stats();
    report.set("transport-id", {
      id: "transport-id",
      type: "transport",
      dtlsState: "connected",
      remoteCertificateId: "missing",
    });
    expect(() =>
      verifyRemoteDtlsFingerprint(report, { algorithm: "sha-256", value: EXPECTED }),
    ).toThrow(/remote certificate/i);
  });

  it("rejects certificate stats from a DTLS transport that is not connected", () => {
    for (const dtlsState of ["connecting", "closed", "failed", undefined]) {
      const report = stats();
      report.set("transport-id", {
        id: "transport-id",
        type: "transport",
        dtlsState,
        remoteCertificateId: "remote-cert",
      });
      expect(() =>
        verifyRemoteDtlsFingerprint(report, { algorithm: "sha-256", value: EXPECTED }),
      ).toThrow(/DTLS.*connected/i);
    }
  });

  it("rejects unsupported algorithms and malformed fingerprints", () => {
    expect(() =>
      verifyRemoteDtlsFingerprint(stats(), { algorithm: "sha-1", value: EXPECTED }),
    ).toThrow(/algorithm/i);
    expect(() =>
      verifyRemoteDtlsFingerprint(stats(), { algorithm: "sha-256", value: "A3:5E" }),
    ).toThrow(/fingerprint/i);
    const report = stats();
    report.set("remote-cert", {
      id: "remote-cert",
      type: "certificate",
      fingerprintAlgorithm: "sha-1",
      fingerprint: EXPECTED,
    });
    expect(() =>
      verifyRemoteDtlsFingerprint(report, { algorithm: "sha-256", value: EXPECTED }),
    ).toThrow(/algorithm/i);
  });

  it("rejects an additional transport whose remote certificate differs", () => {
    const report = stats();
    report.set("second-transport", {
      id: "second-transport",
      type: "transport",
      dtlsState: "connected",
      remoteCertificateId: "second-cert",
    });
    report.set("second-cert", {
      id: "second-cert",
      type: "certificate",
      fingerprintAlgorithm: "sha-256",
      fingerprint: OTHER,
    });
    expect(() =>
      verifyRemoteDtlsFingerprint(report, { algorithm: "sha-256", value: EXPECTED }),
    ).toThrow(/mismatch/i);
  });
});
