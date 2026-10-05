/** Bounded linear PEM decoding shared by configuration and both signing adapters. */
export function decodePrivateKeyPem(value: unknown): Uint8Array<ArrayBuffer> {
  const invalid = () => new Error("Invalid provider key");
  if (typeof value !== "string" || value.length > 16384) throw invalid();
  const label = "PRIVATE KEY";
  const begin = `-----BEGIN ${label}-----`;
  const end = `-----END ${label}-----`;
  const trimmed = value.trimEnd();
  if (!trimmed.startsWith(begin) || !trimmed.endsWith(end)) throw invalid();
  const body = trimmed.slice(begin.length, -end.length);
  // Separate boundary checks prevent overlapping whitespace/body quantifiers.
  if (!/^\s/.test(body) || !/\s$/.test(body)) throw invalid();
  const encoded = body.replace(/\s/g, "");
  if (!encoded.length || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))
    throw invalid();
  try {
    return Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
  } catch {
    throw invalid();
  }
}
