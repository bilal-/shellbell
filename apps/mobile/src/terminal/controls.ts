export type TerminalCommand =
  | { type: "focus" }
  | { type: "blur" }
  | { type: "paste"; text: string; submit?: boolean }
  | { type: "input"; data: string }
  | { type: "select-all" }
  | { type: "select"; enabled: boolean }
  | { type: "copy"; format: "text" | "html"; request?: string }
  | {
      type: "search";
      text: string;
      direction: "next" | "previous";
      caseSensitive: boolean;
      wholeWord: boolean;
      regex: boolean;
    }
  | { type: "clear-search" };

/** A local command boundary only. Transport stays in the native connection owner. */
export class TerminalControls {
  private send: ((command: TerminalCommand) => boolean) | undefined;
  bind(send: (command: TerminalCommand) => boolean): () => void {
    this.send = send;
    return () => {
      if (this.send === send) this.send = undefined;
    };
  }
  command(command: TerminalCommand): boolean {
    return this.send?.(command) ?? false;
  }
}
