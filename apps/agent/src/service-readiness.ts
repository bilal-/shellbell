import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { controlRequest } from "./control.js";
import { type LocalStatus, LocalStatusSchema } from "./local-status.js";

export interface ExpectedLocalService {
  computerFp: string;
  stateDir: string;
  serviceInstance?: string | null;
  pid?: number;
}
export interface ReadinessOptions {
  clock?: { now(): number; sleep(ms: number): Promise<void> };
  probe?: (sockPath: string, timeoutMs: number) => Promise<unknown>;
}
export interface LocalObservation {
  kind: "verified" | "foreign" | "absent" | "unverified";
  local: LocalStatus | null;
  diagnostic?: string;
}

export function canonicalStateDir(path: string): string {
  try {
    return realpathSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return resolve(path);
    throw new Error(`Cannot resolve state directory ${path}`);
  }
}

export function matchesLocalService(status: LocalStatus, expected: ExpectedLocalService): boolean {
  try {
    return (
      status.process.computerFp === expected.computerFp &&
      canonicalStateDir(status.process.stateDir) === canonicalStateDir(expected.stateDir) &&
      (expected.serviceInstance === undefined ||
        status.process.serviceInstance === expected.serviceInstance) &&
      (expected.pid === undefined || status.process.pid === expected.pid)
    );
  } catch {
    // The received path is untrusted; never echo it in a diagnostic.
    return false;
  }
}

/** Only transport-level absence proves an endpoint stopped; a timeout never does. */
export class ServiceReadiness {
  private readonly clock;
  private readonly probe;
  constructor(options: ReadinessOptions = {}) {
    this.clock = options.clock ?? {
      now: () => performance.now(),
      sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    };
    this.probe =
      options.probe ??
      ((sockPath: string, timeoutMs: number) =>
        controlRequest(sockPath, "status", undefined, { timeoutMs, maxResponseBytes: 64 * 1024 }));
  }

  async observe(
    sockPath: string,
    expected?: ExpectedLocalService,
    timeoutMs = 500,
  ): Promise<LocalObservation> {
    let payload: unknown;
    try {
      payload = await this.probe(sockPath, timeoutMs);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return code === "ENOENT" || code === "ECONNREFUSED"
        ? { kind: "absent", local: null, diagnostic: "Local endpoint is absent" }
        : {
            kind: "unverified",
            local: null,
            diagnostic: "Local endpoint did not return a bounded status response",
          };
    }
    const parsed = LocalStatusSchema.safeParse(payload);
    if (!parsed.success)
      return {
        kind: "unverified",
        local: null,
        diagnostic: "Local endpoint uses an unsupported or malformed status protocol",
      };
    if (expected && !matchesLocalService(parsed.data, expected))
      return {
        kind: "foreign",
        local: parsed.data,
        diagnostic:
          "Local endpoint belongs to a different process, identity, state directory, or service instance",
      };
    return { kind: "verified", local: parsed.data };
  }

  async waitReady(sockPath: string, expected: ExpectedLocalService): Promise<LocalStatus> {
    const result = await this.wait(sockPath, expected, false);
    return result.local!;
  }

  async waitStopped(sockPath: string): Promise<void> {
    await this.wait(sockPath, undefined, true);
  }

  private async wait(
    sockPath: string,
    expected: ExpectedLocalService | undefined,
    stopping: boolean,
  ): Promise<LocalObservation> {
    const deadline = this.clock.now() + 10_000;
    let diagnostic = "Local endpoint is absent";
    while (this.clock.now() < deadline) {
      const observed = await this.observe(
        sockPath,
        expected,
        Math.min(500, deadline - this.clock.now()),
      );
      if (stopping ? observed.kind === "absent" : observed.kind === "verified") return observed;
      diagnostic = observed.diagnostic ?? "Local endpoint is still responding";
      if (!stopping && observed.kind === "foreign")
        throw new Error(
          `Service readiness conflict: ${diagnostic}; stop the foreground owner before retrying`,
        );
      const remaining = deadline - this.clock.now();
      if (remaining > 0) await this.clock.sleep(Math.min(100, remaining));
    }
    throw new Error(`${stopping ? "Service stop" : "Service readiness"} timed out: ${diagnostic}`);
  }
}
