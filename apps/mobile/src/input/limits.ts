/** Mirrors `InnerMessageSchema`'s `input.line.text` bound (`packages/protocol/src/inner.ts`).
 *  Without a client-side guard, an over-limit line is dropped by the agent's strict parser with
 *  no `ack` at all, so the request just hangs until the socket closes (review M15). */
export const MAX_LINE_LENGTH = 8192;

export function lineExceedsLimit(text: string): boolean {
  return text.length > MAX_LINE_LENGTH;
}
