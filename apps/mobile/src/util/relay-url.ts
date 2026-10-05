/** Relay origins match pairing QR rules; an insecure origin needs explicit local-test consent. */
export function parseRelaySetting(value: string, allowInsecure: boolean): string {
  const url = new URL(value.trim());
  if (url.protocol !== "wss:" && !(allowInsecure && url.protocol === "ws:"))
    throw new Error("Use wss://, or enable unencrypted WebSocket for local testing.");
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash)
    throw new Error(
      "Use a relay origin such as wss://relay.example.com, without a path or credentials.",
    );
  const origin = `${url.protocol}//${url.host}`;
  if (origin.length > 256) throw new Error("Relay URL is too long.");
  return origin;
}
