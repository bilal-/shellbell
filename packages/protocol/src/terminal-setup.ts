import type { TerminalSetup } from "./inner.js";

/** Issues the user has to act on. A terminal that is absent or closed is not a problem. */
export function terminalNeedsAttention(setup: TerminalSetup): boolean {
  return (
    setup.issue !== undefined &&
    [
      "needs-consent",
      "automation-denied",
      "iterm2-denied",
      "timed-out",
      "too-old",
      "failed",
      "limited",
    ].includes(setup.issue)
  );
}

export type TerminalSetupSurface = "mac-app" | "command-line" | "phone";

const LABELS: Record<string, string> = { iterm2: "iTerm2", tmux: "tmux", herdr: "Herdr" };

/**
 * One status line and, when there is something to do, one instruction. `surface` decides where
 * the instruction sends the user: a button in the Mac app, a command, or back to the Mac.
 * `noneUsable` is set when the Mac has no usable terminal (`noUsableMacTerminal`), so a missing
 * terminal is not called optional beside the message asking for one.
 */
export function terminalSetupText(
  setup: TerminalSetup,
  surface: TerminalSetupSurface,
  options: { noneUsable?: boolean } = {},
): { status: string; fix?: string } {
  const name = LABELS[setup.name] ?? setup.name;
  if (setup.connected && !setup.issue) return { status: "Connected. Ready for your paired phone." };
  if (surface === "phone") {
    return terminalNeedsAttention(setup)
      ? {
          status: `${name} needs one more step on your Mac.`,
          fix: "Open Shellbell → Settings → Terminals on that Mac, or run shellbell doctor there.",
        }
      : { status: `${name} isn't connected right now.` };
  }
  const connectStep =
    surface === "mac-app" ? "Click Connect iTerm2." : "Run shellbell connect iterm2.";
  switch (setup.issue) {
    case "not-installed":
      return {
        status: options.noneUsable
          ? `Shellbell couldn't find ${name}.`
          : `Shellbell couldn't find ${name}. Optional.`,
        ...(setup.name === "tmux"
          ? { fix: "Install tmux 3.2 or newer, for example: brew install tmux" }
          : {}),
      };
    case "not-running":
      return setup.name === "iterm2"
        ? { status: "iTerm2 isn't open. Open it to see its tabs on your phone." }
        : { status: `${name} isn't running.`, fix: `In any terminal, run: ${setup.name}` };
    case "no-session":
      return { status: "No tmux session is running.", fix: "In any terminal, run: tmux" };
    case "api-off":
      return {
        status: "Turn on iTerm2's Python API to connect.",
        fix: "In iTerm2, open Settings → General → Magic and turn on Enable Python API.",
      };
    case "needs-consent":
      return {
        status: "Ready to connect.",
        fix: `${connectStep} macOS will ask to let Shellbell control iTerm2, and iTerm2 may ask to allow Shellbell. Allow both. Your paired phone can then read and type in your iTerm2 tabs.`,
      };
    case "connecting":
      return { status: "Finish connecting in the macOS or iTerm2 dialog." };
    case "automation-denied":
      return {
        status: "macOS is blocking Shellbell from iTerm2.",
        fix: "Open System Settings → Privacy & Security → Automation, find Shellbell (or node, for the background service) and turn on iTerm2.",
      };
    case "iterm2-denied":
      return {
        status: "iTerm2 is blocking Shellbell.",
        fix: `In iTerm2, open Settings → General → Magic and check who may use the Python API. Then ${connectStep.charAt(0).toLowerCase()}${connectStep.slice(1)}`,
      };
    case "timed-out":
      return {
        status: "Connecting wasn't finished.",
        fix: `Check for an open macOS or iTerm2 dialog, then try again. ${connectStep}`,
      };
    case "too-old":
      return setup.name === "iterm2"
        ? { status: "Update iTerm2 to connect.", fix: "Shellbell needs iTerm2 3.3 or newer." }
        : setup.name === "tmux"
          ? {
              status: "Shellbell needs tmux 3.2 or newer.",
              fix: "Update tmux, for example: brew upgrade tmux",
            }
          : { status: `Update ${name} to connect.` };
    case "limited":
      return {
        status: "Viewing and typing work. Opening new sessions from your phone doesn't.",
        ...(setup.detail ? { fix: setup.detail } : {}),
      };
    default:
      return {
        status: `Shellbell couldn't connect to ${name}.`,
        fix: setup.name === "iterm2" ? `Try again. ${connectStep}` : "Shellbell keeps trying.",
      };
  }
}

/** The terminals that make a Mac usable from a phone; Apple's Terminal alone does not. */
const MAC_TERMINALS = ["iterm2", "tmux", "herdr"] as const;

/**
 * True on a Mac where Shellbell found none of iTerm2, tmux or Herdr and no other terminal, such
 * as a plugin, is connected. A list missing any of them, such as a Linux computer's or an older
 * computer's, is never judged.
 */
export function noUsableMacTerminal(setup: readonly TerminalSetup[]): boolean {
  if (setup.some((entry) => entry.connected)) return false;
  return MAC_TERMINALS.every((name) => {
    const terminal = setup.find((entry) => entry.name === name);
    return terminal !== undefined && !terminal.connected && terminal.issue === "not-installed";
  });
}

/** Why Apple's Terminal is not enough, and what to install instead. */
export function noUsableMacTerminalText(surface: TerminalSetupSurface): {
  status: string;
  fix: string;
} {
  const why =
    "Apple's Terminal only lets other apps see plain text and type whole lines, which isn't enough to use a terminal from your phone, so Shellbell can't use it by itself.";
  if (surface === "phone")
    return {
      status: "Your Mac needs iTerm2, tmux or Herdr.",
      fix: `${why} Install one on your Mac. iTerm2 is the easiest.`,
    };
  const choices =
    "iTerm2 is the easiest: your phone sees every tab and can open new ones. With tmux or Herdr, sessions you run inside them show on your phone, in Terminal too.";
  return {
    status: "Shellbell needs iTerm2, tmux or Herdr on this Mac.",
    fix:
      surface === "command-line"
        ? `${why} ${choices} For example: brew install --cask iterm2, or brew install tmux`
        : `${why} ${choices}`,
  };
}
