import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import type { WebResetReason } from "@shellbell/protocol";
import {
  type PageAddress,
  type PageRegistration,
  type PageRegistry,
  pageAddress,
} from "./page-registry.js";

export class PageStartError extends Error {
  constructor(
    readonly reason: WebResetReason,
    readonly detail?: string,
  ) {
    super(reason);
  }
}
export interface PageInstance extends PageAddress {
  id: string;
  key: string;
  revision: string;
  entryURL?: string;
}
interface Running {
  instance: PageInstance;
  ready: Promise<PageInstance>;
  child?: ChildProcess;
  idle?: ReturnType<typeof setTimeout>;
  stop: () => void;
}
export interface PageProcessOptions {
  home: string;
  idleMs?: number;
  startMs?: number;
  killMs?: number;
  now?: () => number;
  ended?(key: string): void;
}
// The wrapper isolates the child's umask without changing the service's process-global state.
// Program and arguments are literal argv elements, never interpolated into this source or a shell.
const runner = `const {spawn}=require('node:child_process');process.umask(0o022);const p=spawn(process.argv[1],process.argv.slice(2),{stdio:'inherit'});process.on('SIGTERM',()=>{});process.on('SIGINT',()=>{});p.on('error',()=>{process.stderr.write('The page program could not start.\\n');process.exitCode=1});p.on('exit',(code,signal)=>{process.exitCode=code??1});`;
export function pageFailureDetail(line: string): string | undefined {
  const safe = stripVTControlCharacters(line)
    .replace(/https?:\/\/[^\s<>"'\p{Cc}]+/giu, "[address]")
    .replace(/[\p{Cc}]/gu, " ")
    .trim();
  return safe ? safe.slice(0, 120) : undefined;
}
function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
async function stopGroup(pid: number, killMs: number): Promise<void> {
  try {
    process.kill(-pid, "SIGTERM");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ESRCH") return;
  }
  const until = Date.now() + killMs;
  while (groupAlive(pid) && Date.now() < until)
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  if (groupAlive(pid)) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {}
  }
}
export class PageProcesses {
  private readonly running = new Map<string, Running>();
  private readonly views = new Map<string, Set<string>>();
  private readonly starts = new Map<string, number[]>();
  private readonly stopping = new Set<Promise<void>>();
  private closed = false;
  constructor(
    private readonly registry: PageRegistry,
    private readonly options: PageProcessOptions,
  ) {}
  view(id: string, viewer: string, open: boolean): void {
    let viewers = this.views.get(id);
    if (open) {
      if (!viewers) {
        viewers = new Set();
        this.views.set(id, viewers);
      }
      viewers.add(viewer);
      const run = this.running.get(id);
      if (run?.idle) {
        clearTimeout(run.idle);
        run.idle = undefined;
      }
    } else {
      viewers?.delete(viewer);
      if (viewers?.size === 0) {
        this.views.delete(id);
        this.idle(id);
      }
    }
  }
  leave(viewer: string): void {
    for (const [id, viewers] of this.views) if (viewers.has(viewer)) this.view(id, viewer, false);
  }
  reconcile(): void {
    for (const [id, run] of this.running)
      if (this.registry.get(id)?.revision !== run.instance.revision) this.retire(id, run);
  }
  current(instance: PageInstance): boolean {
    return (
      !this.closed &&
      this.registry.get(instance.id)?.revision === instance.revision &&
      this.running.get(instance.id)?.instance.key === instance.key
    );
  }
  async resolve(id: string): Promise<PageInstance> {
    const registration = this.registry.get(id);
    if (this.closed || !registration) throw new PageStartError("not-found");
    let current = this.running.get(id);
    if (current?.instance.revision !== registration.revision && current) {
      this.retire(id, current);
      current = undefined;
    }
    if (current) return current.ready;
    if (registration.url) {
      const instance: PageInstance = {
        ...registration.url,
        id,
        key: `page:${id}:${randomUUID()}`,
        revision: registration.revision,
      };
      const run: Running = { instance, ready: Promise.resolve(instance), stop: () => {} };
      this.running.set(id, run);
      return instance;
    }
    const now = (this.options.now ?? Date.now)();
    const starts = (this.starts.get(id) ?? []).filter((t) => now - t < 300_000);
    if (starts.length >= 4)
      throw new PageStartError(
        "start-failed",
        "This page restarted repeatedly. Try again in a few minutes.",
      );
    starts.push(now);
    this.starts.set(id, starts);
    const run = this.launch(registration);
    this.running.set(id, run);
    if (!this.views.get(id)?.size) this.idle(id);
    return run.ready;
  }
  private launch(registration: PageRegistration): Running {
    let resolve!: (v: PageInstance) => void,
      reject!: (e: PageStartError) => void,
      settled = false,
      retired = false;
    const placeholder: PageInstance = {
      id: registration.id,
      key: `page:${registration.id}:${randomUUID()}`,
      revision: registration.revision,
      origin: {
        origin: "http://localhost",
        authority: "localhost",
        host: { kind: "name", name: "localhost" },
        port: 80,
      },
      path: "/",
      url: "http://localhost/",
    };
    const run: Running = {
      instance: placeholder,
      ready: new Promise((a, b) => {
        resolve = a;
        reject = b;
      }),
      stop: () => {},
    };
    const child = spawn(process.execPath, ["--eval", runner, ...registration.start!], {
      cwd: registration.cwd ?? this.options.home,
      env: {
        ...process.env,
        HOME: this.options.home,
        SHELLBELL_PAGE: registration.id,
        NO_COLOR: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    run.child = child;
    let stdout = Buffer.alloc(0),
      stderr = Buffer.alloc(0);
    const timer = setTimeout(() => fail("start-timeout"), this.options.startMs ?? 15_000);
    timer.unref();
    const cleanup = () => {
      clearTimeout(timer);
      if (run.idle) clearTimeout(run.idle);
    };
    const kill = () => {
      if (!child.pid) return;
      const wait = stopGroup(child.pid, this.options.killMs ?? 3000).finally(() =>
        this.stopping.delete(wait),
      );
      this.stopping.add(wait);
    };
    const fail = (reason: WebResetReason) => {
      if (retired) return;
      retired = true;
      cleanup();
      if (!settled) {
        settled = true;
        reject(
          new PageStartError(
            reason,
            pageFailureDetail(stderr.toString("utf8").trim().split(/\r?\n/).at(-1) ?? ""),
          ),
        );
      }
      if (this.running.get(registration.id) === run) this.running.delete(registration.id);
      this.options.ended?.(run.instance.key);
      kill();
    };
    run.stop = () => fail("closed");
    const output = (chunk: Buffer, isError: boolean) => {
      const previous = isError ? stderr : stdout;
      const tail = Buffer.concat([previous, chunk]).subarray(-4096);
      if (isError) stderr = tail;
      else stdout = tail;
      if (settled) return;
      const text = stripVTControlCharacters(tail.toString("utf8"));
      const urls = [...text.matchAll(/http:\/\/[^\s<>"'\p{Cc}]+/gu)].map((m) => m[0]);
      for (const url of urls) {
        const address = pageAddress(url);
        if (!address) continue;
        if (this.closed || this.registry.get(registration.id)?.revision !== registration.revision) {
          fail("closed");
          return;
        }
        Object.assign(
          run.instance,
          address,
          ...(new URL(address.url).search ? [{ entryURL: address.url }] : []),
        );
        settled = true;
        clearTimeout(timer);
        resolve(run.instance);
        return;
      }
    };
    child.stdout?.on("data", (chunk: Buffer) => output(chunk, false));
    child.stderr?.on("data", (chunk: Buffer) => output(chunk, true));
    child.on("error", () => fail("start-failed"));
    child.on("exit", () => fail("start-failed"));
    return run;
  }
  private idle(id: string): void {
    const run = this.running.get(id);
    if (!run?.child || run.idle) return;
    run.idle = setTimeout(() => {
      if (!this.views.get(id)?.size && this.running.get(id) === run) this.retire(id, run);
    }, this.options.idleMs ?? 300_000);
    run.idle.unref();
  }
  private retire(id: string, run: Running): void {
    if (this.running.get(id) !== run) return;
    this.running.delete(id);
    run.stop();
    if (!run.child) this.options.ended?.(run.instance.key);
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const [id, run] of this.running) this.retire(id, run);
    this.views.clear();
    await Promise.all([...this.stopping]);
  }
}
