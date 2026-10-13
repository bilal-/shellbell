import { createHash } from "node:crypto";
import { RELAY_URL_MAX_LENGTH } from "@shellbell/protocol";
import { ACCENTS, type AgentConfig, AgentConfigSchema } from "./config.js";

/** Pure: is `value` an acceptable relay url? `ws://` is only allowed for LAN dev, via
 * `--insecure` or `SHELLBELL_ALLOW_INSECURE_RELAY=1`. Returns an error message, or null if ok. */
export function validateRelayUrl(value: string, allowInsecure: boolean): string | null {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return "must be a valid URL, e.g. wss://relay.example.com";
  }
  // The pairing QR carries the relay as an origin only (see parseQr); anything else would be
  // saved here and only fail later, when pairing opens. `URL` reports an empty `?` or `#` as no
  // query or hash, so the raw text is checked for them.
  if (value.endsWith("/") || /[?#]/.test(value) || u.pathname !== "/" || u.username || u.password)
    return "relay url must be scheme://host[:port] with no path, query or credentials";
  if (value.length > RELAY_URL_MAX_LENGTH)
    return `relay url is too long for a pairing code (at most ${RELAY_URL_MAX_LENGTH} characters)`;
  if (u.protocol === "wss:") return null;
  if (u.protocol === "ws:") {
    if (allowInsecure) return null;
    return "ws:// is insecure; pass --insecure or set SHELLBELL_ALLOW_INSECURE_RELAY=1 for LAN dev";
  }
  return "relay url must use wss:// (ws:// only with --insecure, for LAN dev)";
}

/**
 * Pure: resolves `shellbell config set <key> <value>` against the current config into either a
 * friendly one-line error or the new, schema-validated config to save. `relay` gets its own
 * wss://-only check (ws:// only with `allowInsecure`, for LAN dev); every key -- including a
 * relay url that passed that check -- is then re-validated against `AgentConfigSchema` so a bad
 * configured field (or any future schema tightening) surfaces the same friendly, one-line message
 * instead of a raw ZodError dump.
 */
export function resolveConfigSet(
  cfg: AgentConfig,
  key: string,
  value: string,
  allowInsecure: boolean,
): { error: string } | { next: AgentConfig } {
  let next: AgentConfig;
  if (key === "relay") {
    const err = validateRelayUrl(value, allowInsecure);
    if (err) return { error: err };
    next = { ...cfg, relayUrl: value };
  } else if (key === "name") {
    next = { ...cfg, computerName: value };
  } else if (key === "accent") {
    if (!(ACCENTS as readonly string[]).includes(value)) {
      return { error: `unknown accent ${value} (must be one of ${ACCENTS.join(", ")})` };
    }
    next = { ...cfg, accent: value };
  } else if (key === "turn") {
    if (value !== "on" && value !== "off") return { error: "turn must be on or off" };
    const { turn: _previous, ...rest } = cfg;
    next = value === "off" ? { ...rest, turn: false } : rest;
  } else if (isConfigThresholdKey(key)) {
    if (!/^\d+$/.test(value)) {
      return { error: `${key} must be a complete decimal integer` };
    }
    const number = Number(value);
    if (!Number.isSafeInteger(number)) {
      return { error: `${key} must be a safe decimal integer` };
    }
    next = { ...cfg, [key]: number };
  } else {
    return { error: `unknown key ${key} (expected ${friendlyConfigKeys()})` };
  }
  const result = AgentConfigSchema.safeParse(next);
  if (!result.success) {
    return { error: result.error.issues.map((i) => i.message).join("; ") };
  }
  return { next: result.data };
}

const CONFIG_THRESHOLD_KEYS = ["notifyMinCommandMs", "idleQuietMs", "idleMinActiveMs"] as const;
export const CONFIG_KEYS = ["relay", "name", "accent", ...CONFIG_THRESHOLD_KEYS, "turn"] as const;

function isConfigThresholdKey(key: string): key is (typeof CONFIG_THRESHOLD_KEYS)[number] {
  return (CONFIG_THRESHOLD_KEYS as readonly string[]).includes(key);
}

function friendlyConfigKeys(): string {
  return `${CONFIG_KEYS.slice(0, -1).join(", ")}, or ${CONFIG_KEYS.at(-1)}`;
}

export type ConfigKey = (typeof CONFIG_KEYS)[number];

/** A setting's current value, written the way `config set` takes it. */
export function configValue(cfg: AgentConfig, key: ConfigKey): string {
  switch (key) {
    case "relay":
      return cfg.relayUrl;
    case "name":
      return cfg.computerName;
    case "accent":
      return cfg.accent;
    case "turn":
      return cfg.turn === false ? "off" : "on";
    default:
      return String(cfg[key]);
  }
}

export function configRevision(cfg: AgentConfig): string {
  const c = AgentConfigSchema.parse(cfg);
  return createHash("sha256")
    .update(
      JSON.stringify({
        v: c.v,
        relayUrl: c.relayUrl,
        computerName: c.computerName,
        accent: c.accent,
        notifyMinCommandMs: c.notifyMinCommandMs,
        idleQuietMs: c.idleQuietMs,
        idleMinActiveMs: c.idleMinActiveMs,
        ...(c.terminalPlugins?.length ? { terminalPlugins: c.terminalPlugins } : {}),
        ...(c.turn === false ? { turn: false } : {}),
      }),
    )
    .digest("hex");
}
