const ESC = 0x1b;
const K = 0x6b;
const BACKSLASH = 0x5c;
const CAN = 0x18;
const SUB = 0x1a;

/**
 * Removes `ESC k name ESC \` window names from a pane's bytes, as tmux does. Shells inside tmux
 * send them because tmux, like screen, names windows from them; xterm.js does not know the
 * sequence and would print the name as text.
 *
 * Follows tmux's parser: the name runs until any ESC, which starts the next sequence unless it
 * is the `ESC \` ending the name, and CAN or SUB cancel it. A trailing ESC waits for the next
 * chunk.
 */
export class ScreenNameFilter {
  private state: "ground" | "esc" | "name" | "name-esc" = "ground";

  write(data: Uint8Array): Uint8Array {
    const out = new Uint8Array(data.length + 1);
    let length = 0;
    for (const byte of data) {
      if (this.state === "name-esc" && byte === BACKSLASH) {
        this.state = "ground";
        continue;
      }
      if (this.state === "esc" || this.state === "name-esc") {
        if (byte === K) {
          this.state = "name";
          continue;
        }
        out[length++] = ESC;
        this.state = "ground";
      }
      if (byte === ESC) {
        this.state = this.state === "name" ? "name-esc" : "esc";
      } else if (this.state === "name") {
        if (byte === CAN || byte === SUB) {
          out[length++] = byte;
          this.state = "ground";
        }
      } else {
        out[length++] = byte;
      }
    }
    return out.subarray(0, length);
  }
}
