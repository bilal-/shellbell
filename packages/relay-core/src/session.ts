import {
  Bytes,
  FpSchema,
  fromBase64Url,
  ProtocolError,
  parseCtrl,
  toBase64Url,
} from "@shellbell/protocol";

export type SessionRecord = Readonly<{
  version: 1;
  state: "unauth" | "agent" | "phone" | "pairing";
  connId: string;
  nonce: string;
  since: number;
  fp: string | null;
  name: string | null;
  leaseUntil: number;
  used?: boolean;
}>;

const required = ["state", "connId", "nonce", "since", "fp", "name", "leaseUntil"];
const allowed = new Set([...required, "version", "used"]);

function invalid(): never {
  throw new ProtocolError("malformed", "invalid session record");
}

/** Validate before restoring runtime state; only versionless legacy records are normalized. */
export function decodeSession(value: unknown): SessionRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
  const record = value as Record<string, unknown>;
  if (
    required.some((key) => !Object.hasOwn(record, key)) ||
    Reflect.ownKeys(record).some((key) => typeof key !== "string" || !allowed.has(key)) ||
    (Object.hasOwn(record, "version") && record.version !== 1)
  ) {
    invalid();
  }
  const { state, connId, nonce, since, fp, name, leaseUntil } = record;
  if (state !== "unauth" && state !== "agent" && state !== "phone" && state !== "pairing") {
    invalid();
  }
  if (typeof nonce !== "string" || nonce.length !== 43 || typeof connId !== "string") invalid();
  const nonceBytes = fromBase64Url(nonce);
  Bytes(32).parse(nonceBytes);
  if (toBase64Url(nonceBytes) !== nonce) invalid();
  parseCtrl({ type: "challenge", nonce: nonceBytes, connId });
  if (
    typeof since !== "number" ||
    !Number.isFinite(since) ||
    since < 0 ||
    typeof leaseUntil !== "number" ||
    !Number.isFinite(leaseUntil) ||
    leaseUntil < 0
  ) {
    invalid();
  }
  if (state === "unauth") {
    if (fp !== null || name !== null) invalid();
  } else {
    FpSchema.parse(fp);
    if (typeof fp !== "string" || typeof name !== "string" || name.length < 1 || name.length > 64) {
      invalid();
    }
  }
  if (state !== "phone" && leaseUntil !== 0) invalid();
  const hasUsed = Object.hasOwn(record, "used");
  if (hasUsed && (state !== "pairing" || typeof record.used !== "boolean")) invalid();
  return {
    version: 1,
    state,
    connId,
    nonce,
    since,
    fp: fp as string | null,
    name: name as string | null,
    leaseUntil,
    ...(hasUsed ? { used: record.used as boolean } : {}),
  };
}
