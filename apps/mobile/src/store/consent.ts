import Storage from "expo-sqlite/kv-store";
import { parseRelaySetting } from "../util/relay-url";

export const TERMS_VERSION = "2026-10-09";
export const TERMS_URL = `https://github.com/bilal-/shellbell/blob/main/legal/terms/${TERMS_VERSION}.md`;
export const PRIVACY_URL = "https://github.com/bilal-/shellbell/blob/main/PRIVACY.md";
const TERMS_KEY = "shellbell.terms.v1";
const RELAYS_KEY = "shellbell.relay-consent.v1";
const RELAY_NOTICE_VERSION = 1;

function read(key: string): unknown {
  const raw = Storage.getItemSync(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function hasAcceptedTerms(): boolean {
  const saved = read(TERMS_KEY) as { version?: unknown; acceptedAt?: unknown } | null;
  return (
    saved?.version === TERMS_VERSION &&
    typeof saved.acceptedAt === "string" &&
    Number.isFinite(Date.parse(saved.acceptedAt))
  );
}

export function acceptTerms(): void {
  Storage.setItemSync(
    TERMS_KEY,
    JSON.stringify({ version: TERMS_VERSION, acceptedAt: new Date().toISOString() }),
  );
}

function acceptedRelays(): string[] {
  const saved = read(RELAYS_KEY) as { version?: unknown; origins?: unknown } | null;
  return saved?.version === RELAY_NOTICE_VERSION && Array.isArray(saved.origins)
    ? saved.origins.filter((origin): origin is string => typeof origin === "string")
    : [];
}

export function hasAcceptedRelay(value: string): boolean {
  return acceptedRelays().includes(parseRelaySetting(value, true));
}

export function acceptRelay(value: string): void {
  const origin = parseRelaySetting(value, true);
  const origins = [...acceptedRelays().filter((item) => item !== origin), origin].slice(-64);
  Storage.setItemSync(RELAYS_KEY, JSON.stringify({ version: RELAY_NOTICE_VERSION, origins }));
}
