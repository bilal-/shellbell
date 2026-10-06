import { encodeCbor, type InnerMessageOf, MAX_TERMINAL_MESSAGE_BYTES } from "@shellbell/protocol";

/** Mirrors `InnerMessageSchema`'s `input.line.text` bound (`packages/protocol/src/inner.ts`).
 *  Without a client-side guard, an over-limit line is dropped by the agent's strict parser with
 *  no `ack` at all, so the request just hangs until the socket closes (review M15). */
export const MAX_LINE_LENGTH = 8192;

export function lineExceedsLimit(text: string): boolean {
  return text.length > MAX_LINE_LENGTH;
}

/** Size the complete UTF-8 CBOR message before admitting any related keystrokes. */
export function inputTextExceedsLimit(
  message:
    | InnerMessageOf<"input.text">
    | InnerMessageOf<"input.terminal">
    | InnerMessageOf<"input.paste">,
): boolean {
  return (
    (message.type === "input.terminal" ? message.data : message.text).length >
      MAX_TERMINAL_MESSAGE_BYTES || encodeCbor(message).length > MAX_TERMINAL_MESSAGE_BYTES
  );
}
