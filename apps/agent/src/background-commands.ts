import { userInfo } from "node:os";
import type { Command } from "commander";
import type { Background, BackgroundStatus } from "./background.js";
import { ServiceLifecycleError } from "./service-lifecycle.js";
import { SystemdUnavailableError } from "./systemd-lifecycle.js";

/** What macOS may ask after a background install, said before it asks. */
export const MACOS_SERVICE_PROMPTS = `
  macOS may now ask a few questions. Each one is optional:
  - "Background Items Added: node" is Shellbell. node is the runtime Shellbell runs on.
  - "node" or "osascript" wants to control "iTerm2" appears when you run
    shellbell connect iterm2, so your phone can show iTerm2 tabs and type into them.
    Shellbell controls no other app.
  - "Find devices on your local network" lets your phone connect straight to this Mac on the
    same Wi-Fi. Without it, your phone may not connect while it is on the same Wi-Fi.
  Change any answer later in System Settings → Privacy & Security.`;

export const NO_BACKGROUND_ON_THIS_COMPUTER =
  "This computer can't run Shellbell in the background: it has no systemd user session, as is common in containers. Run `shellbell run` to keep Shellbell running in this window.";

const OTHER_COPY =
  "Shellbell is running in a terminal window. Press Ctrl-C in that window, then try again.";

/** A failed background change, in words that say what to do next. */
export function explainBackgroundError(error: unknown): string {
  if (error instanceof SystemdUnavailableError) return NO_BACKGROUND_ON_THIS_COMPUTER;
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^shellbell: /, "");
}

/** Where Shellbell stands after a change, and what keeps it running. */
export function describeBackground(
  s: BackgroundStatus,
  system: Background["system"],
  user = userInfo().username,
): string[] {
  if (!s.running) {
    if (!s.available) return [NO_BACKGROUND_ON_THIS_COMPUTER];
    if (!s.installed)
      return [
        "Shellbell doesn't run in the background on this computer yet. Run `shellbell install`.",
      ];
    return [
      s.startsAtLogin
        ? "Shellbell is stopped. It starts again the next time you log in, or run `shellbell start`."
        : "Shellbell is stopped. Run `shellbell start` to start it.",
    ];
  }
  const lines = [
    `Shellbell ${s.version ?? ""} is running in the background${s.startsAtLogin ? " and starts again whenever you log in" : ""}.`.replace(
      "  ",
      " ",
    ),
  ];
  if (system === "macos" && s.startsAtLogin)
    lines.push("After this Mac restarts, log in once so your phone can reach it.");
  if (system === "linux" && !s.keepsRunningAfterLogout)
    lines.push(
      `It stops when you log out. To keep it running after you log out, an administrator can run: sudo loginctl enable-linger ${user}`,
    );
  return lines;
}

export interface BackgroundCommandDeps {
  background: () => Background;
  version: string;
  /** Asks for the agent helpers, once, before a first install. */
  offerAgents?: () => Promise<void>;
  /** After an install in a terminal: opens pairing when no phone is paired yet. */
  afterInstall?: () => Promise<void>;
  /** Whether something else answers on this computer's control socket. */
  otherCopyRunning?: () => Promise<boolean>;
  /** Says so and returns true when the Mac app runs Shellbell here. */
  appOwned?: () => boolean;
}

export interface CommandOutput {
  log: (line: string) => void;
  error: (line: string) => void;
}
const consoleOutput: CommandOutput = {
  log: (line) => console.log(line),
  error: (line) => console.error(line),
};

/** Installs and starts the background Shellbell, then says where it stands. */
export async function installBackground(
  deps: BackgroundCommandDeps,
  json: boolean,
  out: CommandOutput = consoleOutput,
): Promise<number> {
  try {
    const background = deps.background();
    background.checkRuntime();
    if (deps.appOwned?.()) return 2;
    const before = await background.status();
    if (!before.running && (await deps.otherCopyRunning?.())) {
      report(new Error(OTHER_COPY), json, out);
      return 2;
    }
    if (!json && !before.installed && before.available) await deps.offerAgents?.();
    const after = await background.install(deps.version);
    if (json) out.log(JSON.stringify(after));
    else {
      for (const line of describeBackground(after, background.system)) out.log(`  ${line}`);
      if (after.running && !before.installed && background.system === "macos")
        out.log(MACOS_SERVICE_PROMPTS);
    }
    if (!after.running) return 2;
    if (!json) await deps.afterInstall?.();
    return 0;
  } catch (error) {
    report(error, json, out);
    return 2;
  }
}

function report(error: unknown, json: boolean, out: CommandOutput): void {
  const message = explainBackgroundError(error);
  // A change that couldn't be undone keeps the old definition aside for recovery.
  const rollback =
    error instanceof ServiceLifecycleError
      ? {
          rollback: error.rollback,
          rollbackDiagnostic: error.rollbackDiagnostic,
          recoveryPath: error.recoveryPath,
        }
      : {};
  if (json) out.log(JSON.stringify({ error: message, ...rollback }));
  else {
    out.error(`  ${message}`);
    if (rollback.rollback === "failed")
      out.error(
        `  Shellbell couldn't put the previous setup back${rollback.rollbackDiagnostic ? ` (${rollback.rollbackDiagnostic})` : ""}.${rollback.recoveryPath ? ` A copy of it is saved at ${rollback.recoveryPath}.` : ""}`,
      );
  }
}

async function change(
  deps: BackgroundCommandDeps,
  json: boolean,
  out: CommandOutput,
  command: "start" | "stop" | "restart" | "uninstall",
): Promise<number> {
  try {
    if (deps.appOwned?.()) return 2;
    const background = deps.background();
    const before = await background.status();
    if (!before.installed) {
      if (json) out.log(JSON.stringify(before));
      else if (command !== "start" && (await deps.otherCopyRunning?.()))
        out.log(
          "  Shellbell is running in a terminal window, not in the background. Press Ctrl-C in that window to stop it.",
        );
      else if (command === "uninstall" || command === "stop")
        out.log("  Shellbell doesn't run in the background on this computer.");
      else for (const line of describeBackground(before, background.system)) out.log(`  ${line}`);
      return command === "uninstall" || command === "stop" ? 0 : 2;
    }
    const after = await background[command]();
    // Removed means nothing starts it at login either, including a link Shellbell didn't make.
    const done =
      command === "uninstall"
        ? !after.installed && !after.startsAtLogin
        : (command === "stop") !== after.running;
    if (json) out.log(JSON.stringify(after));
    else if (command === "uninstall")
      out.log(
        done
          ? "  Shellbell no longer runs in the background. Your phones stay paired; run `shellbell install` to turn it back on."
          : `  Shellbell's background setup is removed, but something else still starts it when you log in. ${after.service.diagnostic ?? ""}`.trimEnd(),
      );
    else for (const line of describeBackground(after, background.system)) out.log(`  ${line}`);
    return done ? 0 : 2;
  } catch (error) {
    report(error, json, out);
    return 2;
  }
}

/** `start` when Shellbell runs in the background already; other cases stay with the caller. */
export const startBackground = (
  deps: BackgroundCommandDeps,
  json: boolean,
  out: CommandOutput = consoleOutput,
) => change(deps, json, out, "start");

export function addBackgroundCommands(root: Command, deps: BackgroundCommandDeps): void {
  const json = () => Boolean(root.opts<{ json?: boolean }>().json);
  root
    .command("install")
    .description("run Shellbell in the background, starting again whenever you log in")
    .action(async () => {
      process.exitCode = await installBackground(deps, json());
    });
  root
    .command("uninstall")
    .description("stop running Shellbell in the background; your phones stay paired")
    .action(async () => {
      process.exitCode = await change(deps, json(), consoleOutput, "uninstall");
    });
  root
    .command("stop")
    .description("stop Shellbell until you next log in or run start")
    .action(async () => {
      process.exitCode = await change(deps, json(), consoleOutput, "stop");
    });
  root
    .command("restart")
    .description("restart the background Shellbell, for example after config set")
    .action(async () => {
      process.exitCode = await change(deps, json(), consoleOutput, "restart");
    });
}
