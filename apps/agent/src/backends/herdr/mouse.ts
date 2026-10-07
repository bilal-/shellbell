import { type ChildProcessWithoutNullStreams, execFile, spawn } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type { TerminalMouseClick } from "@shellbell/protocol";
import { Unsupported } from "../types.js";
import { semverAtLeast } from "./client.js";
import { findHerdrExecutable } from "./executable.js";

const readVersion = promisify(execFile);
const MAX_LINE_BYTES = 1_048_576;

export interface HerdrMouseOptions {
  socketPath: string;
  env?: NodeJS.ProcessEnv;
  executable?: string;
  readVersion?: (executable: string) => Promise<string>;
  spawn?: (
    executable: string,
    args: string[],
    env: NodeJS.ProcessEnv,
  ) => ChildProcessWithoutNullStreams;
  timeoutMs?: number;
}

/** Native terminal control is exclusive. Never request takeover, and release after one click. */
export class HerdrMouseController {
  private executable: string | undefined;
  private readonly env: NodeJS.ProcessEnv;
  private readonly active = new Map<string, () => void>();
  private generation = 0;

  constructor(private readonly opts: HerdrMouseOptions) {
    // Pin the native CLI to the same JSON API instance, including custom/named sockets.
    this.env = { ...(opts.env ?? process.env), HERDR_SOCKET_PATH: opts.socketPath };
  }

  get available(): boolean {
    return this.executable !== undefined;
  }

  get verifiedExecutable(): string | undefined {
    return this.executable === undefined ? undefined : resolve(this.executable);
  }

  async configure(serverVersion: string | undefined): Promise<void> {
    this.close();
    const generation = this.generation;
    if (!serverVersion || semverAtLeast(serverVersion, [0, 9, 3]) !== true) return;
    const executable = this.opts.executable ?? findHerdrExecutable(this.env);
    if (!executable) return;
    try {
      const output = this.opts.readVersion
        ? await this.opts.readVersion(executable)
        : (
            await readVersion(executable, ["--version"], {
              env: this.env,
              timeout: 3000,
              maxBuffer: 4096,
            })
          ).stdout;
      const version = /\b(?:herdr\s+)?v?(\d+\.\d+\.\d+(?:-[\w.-]+)?)/.exec(output)?.[1];
      // The native protocol is version-dependent; the JSON API floor alone is insufficient.
      if (generation === this.generation && version === serverVersion.replace(/^v/, ""))
        this.executable = executable;
    } catch {
      /* Mouse is optional; ordinary Herdr streaming and keys remain available. */
    }
  }

  close(): void {
    this.generation++;
    this.executable = undefined;
    for (const cancel of this.active.values()) cancel();
    this.active.clear();
  }

  async click(target: string, click: TerminalMouseClick, current: () => boolean): Promise<void> {
    const executable = this.executable;
    if (!executable || !current() || this.active.has(target) || this.active.size >= 4)
      throw new Unsupported("mouse control unavailable");
    if (click.column >= click.cols || click.row >= click.rows)
      throw new Unsupported("mouse coordinates");
    const generation = this.generation;
    const args = [
      "terminal",
      "session",
      "control",
      target,
      "--cols",
      String(click.cols),
      "--rows",
      String(click.rows),
    ];
    const child = this.opts.spawn
      ? this.opts.spawn(executable, args, this.env)
      : spawn(executable, args, { env: this.env, stdio: ["pipe", "pipe", "pipe"] });
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let sent = false;
      let buffer = Buffer.alloc(0);
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.active.delete(target);
        child.kill("SIGKILL");
        if (error) reject(error);
        else resolve();
      };
      const cancel = () =>
        finish(
          sent ? new Error("mouse delivery unknown") : new Unsupported("mouse control unavailable"),
        );
      const timer = setTimeout(cancel, this.opts.timeoutMs ?? 3000);
      this.active.set(target, cancel);
      child.on("error", cancel);
      child.stdin.on("error", cancel);
      // Never log the native stream: it contains terminal output.
      child.stderr.resume();
      child.stdout.on("data", (data: Buffer) => {
        if (settled || sent) return;
        buffer = Buffer.concat([buffer, data]);
        if (buffer.length > MAX_LINE_BYTES) return cancel();
        const end = buffer.indexOf(10);
        if (end < 0) return;
        let frame: { type?: unknown; width?: unknown; height?: unknown };
        try {
          frame = JSON.parse(buffer.subarray(0, end).toString("utf8"));
        } catch {
          return cancel();
        }
        if (
          frame.type !== "terminal.frame" ||
          frame.width !== click.cols ||
          frame.height !== click.rows ||
          generation !== this.generation ||
          !current()
        )
          return cancel();
        sent = true;
        buffer = Buffer.alloc(0);
        const command = {
          type: "terminal.mouse",
          button: click.button,
          column: click.column,
          row: click.row,
          modifiers: click.modifiers,
        };
        // One ordered write prevents a release from overtaking its press; EOF also releases control.
        child.stdin.end(
          `${[
            { ...command, action: "down" },
            { ...command, action: "up" },
            { type: "terminal.release" },
          ]
            .map((value) => JSON.stringify(value))
            .join("\n")}\n`,
        );
      });
      child.on("close", (code) =>
        finish(
          code === 0 && sent
            ? undefined
            : sent
              ? new Error("mouse delivery unknown")
              : new Unsupported("mouse control unavailable"),
        ),
      );
    });
  }
}
