import { execFile } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { connect } from "node:net";
import { promisify } from "node:util";
import { writeSecretFile } from "../../config.js";
import { ITerm2AuthError, requestCookieAndKey } from "./auth.js";

const run = promisify(execFile);

/** Why iTerm2 is not connected, or what it is waiting for. */
export type ITerm2AccessIssue =
  | "not-running"
  | "api-off"
  | "needs-consent"
  | "connecting"
  | "automation-denied"
  | "iterm2-denied"
  | "timed-out"
  | "too-old"
  | "failed";

export interface ITerm2AccessOptions {
  /** Where the user's earlier approval is remembered; nothing is remembered without it. */
  recordPath?: string;
  /** Treat the user as having approved before, when no record says otherwise. */
  assumeApproved?: boolean;
  /** A person is watching this process's terminal, so macOS may ask right away. */
  interactive?: boolean;
  socketPath: string;
  appName?: string;
  isRunning?: () => Promise<boolean>;
  apiListening?: (socketPath: string) => Promise<boolean>;
  requestCookie?: (appName: string, timeoutMs: number) => Promise<{ cookie: string; key: string }>;
  now?: () => number;
}

/**
 * Decides when Shellbell may make macOS ask "Shellbell wants to control iTerm2". Until the user
 * clicks Connect iTerm2 (or has approved before), every connection attempt stops at checks that
 * never prompt: whether iTerm2 is open and whether its Python API is listening. After iTerm2
 * itself refuses, or a dialog goes unanswered, background attempts wait for the next click, so
 * a dialog never reappears on its own.
 */
export class ITerm2Access {
  private granted: boolean;
  private paused = false;
  private explicit = false;
  private current: ITerm2AccessIssue | undefined = "not-running";
  private readonly listeners = new Set<() => void>();

  constructor(private readonly opts: ITerm2AccessOptions) {
    this.granted = this.readRecord() ?? !!opts.assumeApproved;
  }

  /** The last reason iTerm2 could not connect; undefined after a successful cookie. */
  get issue(): ITerm2AccessIssue | undefined {
    return this.current;
  }

  /** True while an attempt the user started is waiting for macOS or iTerm2. */
  get connecting(): boolean {
    return this.explicit;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Lets the next attempt ask macOS and iTerm2, then runs it through `attempt`. */
  async connect(attempt: () => Promise<void>): Promise<void> {
    if (this.explicit) return;
    this.explicit = true;
    this.paused = false;
    try {
      await attempt();
    } finally {
      this.explicit = false;
      this.emit();
    }
  }

  /** The cookie provider for `ITerm2Client`: only reaches `osascript` when asking is allowed. */
  readonly cookieProvider = async (timeoutMs: number): Promise<{ cookie: string; key: string }> => {
    if (!(await (this.opts.isRunning ?? iTermRunning)())) {
      this.set("not-running");
      throw new ITerm2AuthError("iTerm2 is not running", "not-running");
    }
    if (!(await (this.opts.apiListening ?? socketListening)(this.opts.socketPath))) {
      this.set("api-off");
      throw new Error("iTerm2 Python API is off");
    }
    const mayAsk = this.explicit || (!this.paused && (this.granted || !!this.opts.interactive));
    if (!mayAsk) {
      this.set(this.pausedIssue());
      throw new ITerm2AuthError("waiting for Connect iTerm2", "unknown");
    }
    if (this.explicit) this.set("connecting");
    try {
      const credentials = await (this.opts.requestCookie ?? requestCookieAndKey)(
        this.opts.appName ?? "Shellbell",
        timeoutMs,
      );
      this.remember(true);
      this.set(undefined);
      return credentials;
    } catch (error) {
      const issue = classify(error);
      // A refusal in iTerm2 or an unanswered dialog would ask again on every retry.
      if (issue === "iterm2-denied" || issue === "timed-out") this.paused = true;
      this.set(issue);
      throw error;
    }
  };

  private pausedIssue(): ITerm2AccessIssue {
    if (this.paused && (this.current === "iterm2-denied" || this.current === "timed-out"))
      return this.current;
    return "needs-consent";
  }

  private set(issue: ITerm2AccessIssue | undefined): void {
    if (issue === this.current) return;
    this.current = issue;
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        /* observers cannot affect access */
      }
    }
  }

  private readRecord(): boolean | undefined {
    if (!this.opts.recordPath) return undefined;
    try {
      const record = JSON.parse(readFileSync(this.opts.recordPath, "utf8")) as unknown;
      const approved = (record as { approved?: unknown } | null)?.approved;
      return typeof approved === "boolean" ? approved : undefined;
    } catch {
      return undefined;
    }
  }

  private remember(approved: boolean): void {
    if (this.granted === approved) return;
    this.granted = approved;
    if (!this.opts.recordPath) return;
    try {
      writeSecretFile(
        this.opts.recordPath,
        `${JSON.stringify({ v: 1, approved, at: new Date(this.opts.now?.() ?? Date.now()).toISOString() })}\n`,
      );
    } catch {
      /* the approval still holds for this run */
    }
  }
}

/** macOS refuses Apple Events with -1743; iTerm2's own refusal and cancellations are other errors. */
export function classify(error: unknown): ITerm2AccessIssue {
  if (!(error instanceof ITerm2AuthError)) return "failed";
  if (error.kind === "too-old") return "too-old";
  if (error.kind === "not-running") return "not-running";
  if (/-1743\b|Not authori[sz]ed to send Apple events/i.test(error.message))
    return "automation-denied";
  if (/timed out/i.test(error.message)) return "timed-out";
  if (error.kind === "denied") return "iterm2-denied";
  return "failed";
}

async function iTermRunning(): Promise<boolean> {
  try {
    const uid = process.getuid?.();
    await run(
      "/usr/bin/pgrep",
      [...(uid === undefined ? [] : ["-U", String(uid)]), "-x", "iTerm2"],
      {
        timeout: 2000,
      },
    );
    return true;
  } catch {
    return false;
  }
}

/** iTerm2 listens on its socket only while the Python API is on; a leftover file refuses. */
async function socketListening(path: string): Promise<boolean> {
  try {
    if (!statSync(path).isSocket()) return false;
  } catch {
    return false;
  }
  return new Promise((resolve) => {
    const socket = connect({ path });
    const done = (listening: boolean) => {
      socket.destroy();
      resolve(listening);
    };
    socket.setTimeout(1000, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}
