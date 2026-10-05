/**
 * Bind authenticated signaling to the certificate used by native WebRTC.
 *
 * Reading an `a=fingerprint` line from remote SDP alone is insufficient: a relay could
 * change that line unless it came from authenticated end-to-end signaling. The caller
 * supplies that authenticated value; native getStats() supplies the certificate
 * actually linked to the DTLS transport. No direct route may be activated on failure.
 */

export interface DtlsFingerprint {
  algorithm: string;
  value: string;
}

const SHA256_FINGERPRINT = /^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function canonical(value: unknown): string {
  if (typeof value !== "string") throw new Error("invalid DTLS fingerprint");
  const normalized = value.toUpperCase();
  if (!SHA256_FINGERPRINT.test(normalized)) throw new Error("invalid DTLS fingerprint");
  return normalized;
}

/** Returns the verified SHA-256 fingerprint, or throws closed. */
export function verifyRemoteDtlsFingerprint(
  stats: ReadonlyMap<string, unknown>,
  expected: DtlsFingerprint,
): string {
  if (expected.algorithm.toLowerCase() !== "sha-256") {
    throw new Error("unsupported DTLS fingerprint algorithm");
  }
  const fingerprint = canonical(expected.value);
  let transports = 0;
  for (const [id, rawTransport] of stats) {
    const transport = record(rawTransport);
    if (transport?.type !== "transport") continue;
    transports += 1;
    if (transport.dtlsState !== "connected") {
      throw new Error("remote DTLS transport is not connected");
    }
    if (transport.id !== id || typeof transport.remoteCertificateId !== "string") {
      throw new Error("missing transport-linked remote certificate");
    }
    const certificate = record(stats.get(transport.remoteCertificateId));
    if (certificate?.type !== "certificate" || certificate.id !== transport.remoteCertificateId) {
      throw new Error("missing transport-linked remote certificate");
    }
    if (certificate.fingerprintAlgorithm !== "sha-256") {
      throw new Error("unsupported remote certificate algorithm");
    }
    if (canonical(certificate.fingerprint) !== fingerprint) {
      throw new Error("remote DTLS certificate fingerprint mismatch");
    }
  }
  if (transports === 0) throw new Error("missing transport-linked remote certificate");
  return fingerprint;
}
