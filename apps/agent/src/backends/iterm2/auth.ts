import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export class ITerm2AuthError extends Error {
  constructor(
    message: string,
    public readonly kind: "not-running" | "too-old" | "denied" | "unknown",
  ) {
    super(message);
    this.name = "ITerm2AuthError";
  }
}

/**
 * Asks iTerm2 for a one-time API cookie and key via AppleScript.
 * iTerm2 shows a consent dialog the first time an app name asks (unless the user has
 * enabled "Allow all apps to connect"). Cookies are not reusable across processes.
 */
export async function requestCookieAndKey(
  appName: string,
): Promise<{ cookie: string; key: string }> {
  const running = await runOsascript(
    'if application "iTerm2" is running then\nreturn "yes"\nelse\nreturn "no"\nend if',
  );
  if (running.trim() !== "yes") {
    throw new ITerm2AuthError("iTerm2 is not running", "not-running");
  }
  const safeName = appName.replace(/[\\"]/g, "");
  let out: string;
  try {
    out = await runOsascript(
      `tell application "iTerm2" to request cookie and key for app named "${safeName}"`,
    );
  } catch (err) {
    const msg = String((err as { stderr?: string }).stderr ?? err);
    if (/-274[01]/.test(msg)) throw new ITerm2AuthError("iTerm2 is too old (need 3.3+)", "too-old");
    if (/denied|not allowed|user/i.test(msg)) throw new ITerm2AuthError(msg.trim(), "denied");
    throw new ITerm2AuthError(msg.trim(), "unknown");
  }
  const [cookie, key] = out.trim().split(" ");
  if (!cookie || !key)
    throw new ITerm2AuthError(
      `unexpected osascript output (${out.trim().split(" ").length} token(s), ${out.length} chars)`,
      "unknown",
    );
  return { cookie, key };
}

async function runOsascript(script: string): Promise<string> {
  const { stdout } = await execFileAsync("/usr/bin/osascript", ["-e", script]);
  return stdout;
}
