import {
  encodeCbor,
  type InnerMessageOf,
  MAX_INPUT_LINE_LENGTH,
  MAX_TERMINAL_MESSAGE_BYTES,
} from "@shellbell/protocol";

/** Without a client-side guard, an over-limit line is dropped by the computer's strict parser
 *  with no `ack` at all, so the request just hangs until the socket closes (review M15). */
export function lineExceedsLimit(text: string): boolean {
  return text.length > MAX_INPUT_LINE_LENGTH;
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
