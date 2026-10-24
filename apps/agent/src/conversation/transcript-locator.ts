import type { BigIntStats } from "node:fs";
import { lstat, opendir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize, relative, sep } from "node:path";
import type { AgentTranscriptReference } from "./reference.js";
import type { TranscriptAgent, TranscriptRoots } from "./transcript-file.js";

export const TRANSCRIPT_LOCATOR_DIRECTORIES = 512;
export const TRANSCRIPT_LOCATOR_ENTRIES = 16_384;
export const TRANSCRIPT_LOCATOR_MS = 2000;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const SESSION = new RegExp(`^${UUID}$`, "i");
const CLAUDE_FILE = new RegExp(`^(${UUID})\\.jsonl$`, "i");
const AGY_FILE = new RegExp(`^(${UUID})\\.db$`, "i");
const CODEX_FILE = new RegExp(
  `^rollout-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-(${UUID})(?:_(${UUID}))?\\.jsonl$`,
  "i",
);
const CODEX_DATE_PARTS = [/^\d{4}$/, /^(0[1-9]|1[0-2])$/, /^(0[1-9]|[12]\d|3[01])$/];

export interface TranscriptLocatorOptions {
  enabled: () => boolean;
  /** Explicit projects/ and sessions/ roots; never inferred from the pane's working directory. */
  roots: TranscriptRoots;
}
export interface TranscriptCandidate {
  readonly agent: TranscriptAgent;
  readonly path: string;
  readonly session: string;
}
export type TranscriptLocateReason =
  | "disabled"
  | "cancelled"
  | "unbound"
  | "ambiguous"
  | "unsafe"
  | "unreadable"
  | "changed"
  | "limit";
export type TranscriptLocateResult =
  | { status: "candidate"; candidate: Readonly<TranscriptCandidate> }
  | { status: "unavailable"; reason: TranscriptLocateReason }
  | { status: "busy" };

class Stop extends Error {
  constructor(readonly reason: TranscriptLocateReason) {
    super(reason);
  }
}
function safePath(path: string): boolean {
  return (
    isAbsolute(path) &&
    path.length <= 4096 &&
    normalize(path) === path &&
    !Array.from(path).some((c) => {
      const n = c.charCodeAt(0);
      return n < 32 || (n >= 127 && n <= 159) || (c.length === 1 && n >= 0xd800 && n <= 0xdfff);
    })
  );
}
function sameInode(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}
function sameDirectory(a: BigIntStats, b: BigIntStats): boolean {
  return sameInode(a, b) && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
function owned(stat: BigIntStats): boolean {
  return process.getuid === undefined || stat.uid === BigInt(process.getuid());
}
function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}
function sessionFromName(agent: TranscriptAgent, name: string): string | null {
  if (agent === "agy") return AGY_FILE.exec(name)?.[1]?.toLowerCase() ?? null;
  if (!name.endsWith(".jsonl")) return null;
  return (agent === "claude" ? CLAUDE_FILE : CODEX_FILE).exec(name)?.[1]?.toLowerCase() ?? null;
}
function codexDatePart(part: string, depth: number): boolean {
  return CODEX_DATE_PARTS[depth]?.test(part) ?? false;
}
function supportedRelative(agent: TranscriptAgent, part: string): boolean {
  const parts = part.split(sep);
  if (isAbsolute(part) || parts.some((p) => p === "" || p === "." || p === "..")) return false;
  if (!sessionFromName(agent, parts.at(-1)!)) return false;
  if (agent === "claude") return parts.length === 2;
  if (agent === "agy") return parts.length === 1;
  return parts.length === 1 || (parts.length === 4 && parts.slice(0, 3).every(codexDatePart));
}

/**
 * Finds candidates, not pane ownership. Callers must obtain fresh native proof before and after
 * lookup, verify transcript metadata and use TranscriptFile's no-follow descriptor checks.
 * One scan per locator; directory/entry/deadline limits fail closed, even after finding a match.
 */
export class TranscriptLocator {
  private busy = false;
  constructor(private readonly options: TranscriptLocatorOptions) {}

  async locate(
    reference: AgentTranscriptReference,
    signal?: AbortSignal,
  ): Promise<TranscriptLocateResult> {
    const availability = (): TranscriptLocateReason | null => {
      if (signal?.aborted) return "cancelled";
      try {
        return this.options.enabled() ? null : "disabled";
      } catch {
        return "unreadable";
      }
    };
    const initial = availability();
    if (initial) return { status: "unavailable", reason: initial };
    if (this.busy) return { status: "busy" };
    this.busy = true;
    const controller = new AbortController();
    let stopped: TranscriptLocateReason | null = null;
    let stop!: (reason: TranscriptLocateReason) => void;
    const interrupted = new Promise<TranscriptLocateResult>((resolve) => {
      stop = (reason) => {
        if (stopped) return;
        stopped = availability() ?? reason;
        controller.abort();
        resolve({ status: "unavailable", reason: stopped });
      };
    });
    const onAbort = () => stop("cancelled");
    const timer = setTimeout(() => stop("limit"), TRANSCRIPT_LOCATOR_MS);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    const work = (async (): Promise<TranscriptLocateResult> => {
      try {
        const result = await new Scan(this.options, { ...reference }, controller.signal).run();
        const reason = availability() ?? stopped;
        return reason ? { status: "unavailable", reason } : result;
      } catch (error) {
        return {
          status: "unavailable",
          reason:
            availability() ?? stopped ?? (error instanceof Stop ? error.reason : "unreadable"),
        };
      } finally {
        // A stalled syscall may outlive the caller's deadline. Keep its permit until all work
        // and handle cleanup actually finish; an early return must not allow piled-up scans.
        this.busy = false;
      }
    })();
    try {
      const result = await Promise.race([work, interrupted]);
      const reason = availability() ?? stopped;
      return reason ? { status: "unavailable", reason } : result;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
}

class Scan {
  private readonly deadline = performance.now() + TRANSCRIPT_LOCATOR_MS;
  private readonly directories = new Map<string, BigIntStats>();
  private readonly candidates = new Map<string, BigIntStats>();
  private readonly missingRoots = new Set<string>();
  private entries = 0;
  private session = "";

  constructor(
    private readonly options: TranscriptLocatorOptions,
    private readonly reference: AgentTranscriptReference,
    private readonly signal?: AbortSignal,
  ) {}

  private check(): void {
    if (this.signal?.aborted) throw new Stop("cancelled");
    if (!this.options.enabled()) throw new Stop("disabled");
    if (performance.now() >= this.deadline) throw new Stop("limit");
  }

  async run(): Promise<TranscriptLocateResult> {
    this.check();
    const { agent, kind, value } = this.reference;
    if (
      (agent !== "claude" && agent !== "codex" && agent !== "agy") ||
      (kind !== "id" && kind !== "path") ||
      typeof value !== "string"
    )
      throw new Stop("unsafe");
    this.session =
      kind === "id" ? value.toLowerCase() : (sessionFromName(agent, basename(value)) ?? "");
    if (!SESSION.test(this.session) || (kind === "path" && !safePath(value)))
      throw new Stop("unbound");
    const supplied = this.options.roots[agent];
    if (!Array.isArray(supplied) || !supplied.length || supplied.length > 8)
      throw new Stop("unsafe");
    const configured = [...supplied];
    const roots = new Set<string>();
    for (const root of configured) {
      this.check();
      if (!safePath(root)) throw new Stop("unsafe");
      let existed = false;
      try {
        const canonical = await realpath(root);
        existed = true;
        this.check();
        await this.directory(canonical);
        if (
          [...roots].some(
            (r) =>
              r !== canonical &&
              (canonical.startsWith(r.endsWith(sep) ? r : `${r}${sep}`) ||
                r.startsWith(canonical.endsWith(sep) ? canonical : `${canonical}${sep}`)),
          )
        )
          throw new Stop("unsafe");
        roots.add(canonical);
      } catch (error) {
        if (!missing(error)) throw error;
        if (existed) throw new Stop("changed");
        // A dangling alias is not an absent optional root.
        try {
          await lstat(root);
          throw new Stop("unsafe");
        } catch (checkError) {
          if (!missing(checkError)) throw checkError;
        }
        this.check();
        this.missingRoots.add(root);
      }
    }
    if (kind === "path") {
      // A native path disambiguates the file; no unrelated project/session search is needed.
      const root = [...roots].find((r) => supportedRelative(agent, relative(r, value)));
      if (!root) throw new Stop("unsafe");
      const before = await lstat(value, { bigint: true }).catch((error) => {
        if (missing(error)) throw new Stop("unbound");
        throw error;
      });
      this.check();
      if (!before.isFile() || !owned(before)) throw new Stop("unsafe");
      const path = await realpath(value);
      this.check();
      if (path !== value) throw new Stop("unsafe");
      let parent = dirname(path);
      while (parent !== root) {
        await this.directory(parent);
        parent = dirname(parent);
      }
      await this.candidate(path);
      const candidate = this.candidates.get(path);
      if (!candidate || !sameInode(before, candidate)) throw new Stop("changed");
    } else {
      for (const root of roots) {
        if (agent === "claude") await this.claude(root);
        // One database per conversation, named by its ID, directly in the root.
        else if (agent === "agy") await this.candidate(join(root, `${this.session}.db`));
        else await this.codex(root, 0);
      }
    }
    // Detect observed namespace changes; this is not an atomic filesystem snapshot.
    for (const [path, before] of this.directories) {
      this.check();
      const now = await lstat(path, { bigint: true });
      this.check();
      if (!now.isDirectory() || !sameDirectory(before, now) || (await realpath(path)) !== path)
        throw new Stop("changed");
    }
    for (const root of this.missingRoots) {
      this.check();
      try {
        await lstat(root, { bigint: true });
        throw new Stop("changed");
      } catch (error) {
        if (!missing(error)) throw error;
      }
    }
    if (!this.candidates.size) throw new Stop("unbound");
    const [path, before] = [...this.candidates][0]!;
    const now = await lstat(path, { bigint: true });
    this.check();
    if (!now.isFile() || !owned(now) || !sameInode(before, now)) throw new Stop("changed");
    return {
      status: "candidate",
      candidate: Object.freeze({ agent, path, session: this.session }),
    };
  }

  private async directory(path: string): Promise<void> {
    this.check();
    if (this.directories.has(path)) return;
    if (this.directories.size >= TRANSCRIPT_LOCATOR_DIRECTORIES) throw new Stop("limit");
    if (!safePath(path)) throw new Stop("unsafe");
    const stat = await lstat(path, { bigint: true });
    this.check();
    if (!stat.isDirectory() || !owned(stat) || (await realpath(path)) !== path)
      throw new Stop("unsafe");
    this.check();
    this.directories.set(path, stat);
  }

  private async candidate(path: string): Promise<void> {
    this.check();
    if (!safePath(path)) throw new Stop("unsafe");
    let stat: BigIntStats;
    try {
      stat = await lstat(path, { bigint: true });
    } catch (error) {
      if (missing(error)) return;
      throw error;
    }
    this.check();
    if (!stat.isFile() || !owned(stat) || (await realpath(path)) !== path) throw new Stop("unsafe");
    this.check();
    this.candidates.set(path, stat);
    if (this.candidates.size > 1) throw new Stop("ambiguous");
  }

  private async visit(path: string, action: (name: string) => Promise<void>): Promise<void> {
    await this.directory(path);
    this.check();
    const dir = await opendir(path, { bufferSize: 32 });
    try {
      for (;;) {
        this.check();
        const entry = await dir.read();
        this.check();
        if (!entry) break;
        if (++this.entries > TRANSCRIPT_LOCATOR_ENTRIES) throw new Stop("limit");
        await action(entry.name);
      }
    } finally {
      await dir.close();
    }
  }

  private async claude(root: string): Promise<void> {
    await this.visit(root, async (name) => {
      const path = join(root, name);
      const stat = await lstat(path, { bigint: true });
      this.check();
      // Project directory aliases could conceal a second match; don't silently skip them.
      if (stat.isSymbolicLink()) throw new Stop("unsafe");
      if (!stat.isDirectory()) return;
      await this.directory(path);
      await this.candidate(join(path, `${this.session}.jsonl`));
    });
  }

  private async codex(root: string, depth: number): Promise<void> {
    await this.visit(root, async (name) => {
      const path = join(root, name);
      if ((depth === 0 || depth === 3) && sessionFromName("codex", name) === this.session) {
        await this.candidate(path);
      } else if (
        (depth === 0 || depth === 3) &&
        name.toLowerCase().startsWith("rollout-") &&
        name.toLowerCase().includes(this.session)
      ) {
        // Compressed or unknown variants for the same thread cannot be ignored in favor of
        // a possibly obsolete uncompressed rollout. An explicit native path can disambiguate.
        throw new Stop("unbound");
      } else if (depth < 3 && codexDatePart(name, depth)) {
        await this.codex(path, depth + 1);
      }
    });
  }
}
