import { parseRelaySetting } from "./relay-url";

const PROJECT_RELAY = "wss://relay.shellbell.dev";

export const CUSTOM_RELAY_NOTICE =
  "Only use this relay if you know who operates it and understand its setup and privacy practices. " +
  "Its operator receives connection and routing metadata and may log or retain it. " +
  "Terminal content stays end-to-end encrypted, but the operator can delay or block connections. " +
  "Shellbell cannot verify another operator’s practices.";

export function isCustomRelay(value: string): boolean {
  return parseRelaySetting(value, true) !== PROJECT_RELAY;
}

export function relayTrustMessage(value: string): string {
  const origin = parseRelaySetting(value, true);
  return `${origin}\n\n${CUSTOM_RELAY_NOTICE}${
    origin.startsWith("ws:")
      ? "\n\nThis connection also uses unencrypted WebSocket transport. Use it only for local testing."
      : ""
  }`;
}
