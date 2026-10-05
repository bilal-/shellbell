import { spawn } from "node:child_process";
export type ServiceCommand = (
  executable: string,
  args: readonly string[],
  options: {
    input?: Uint8Array;
    timeoutMs: number;
    maxOutputBytes: number;
    captureOutput: boolean;
  },
) => Promise<{ exitCode: number; stdout: Buffer }>;

export const runServiceCommand: ServiceCommand = (executable, args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, stdio: ["pipe", "pipe", "pipe"] });
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdout: Buffer[] = [];
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      reject(error);
    };
    const timer = setTimeout(() => fail(new Error(`${executable} timed out`)), options.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > options.maxOutputBytes)
        return fail(new Error(`${executable} output limit exceeded`));
      if (options.captureOutput) stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > options.maxOutputBytes)
        fail(new Error(`${executable} output limit exceeded`));
    });
    child.on("error", fail);
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal || code === null) return reject(new Error(`${executable} terminated by signal`));
      resolve({
        exitCode: code,
        stdout: options.captureOutput ? Buffer.concat(stdout) : Buffer.alloc(0),
      });
    });
    child.stdin.on("error", fail);
    child.stdin.end(options.input);
  });
