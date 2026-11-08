import http from "node:http";
import { connectAddresses, sameLocalPage, type WebPage } from "@shellbell/protocol";
import type { CookieJar, CookieJars } from "./cookie-jar.js";
import {
  type PageInstance,
  PageProcesses,
  type PageProcessOptions,
  PageStartError,
} from "./page-processes.js";
import { PageRegistry, type PageRegistryOptions, pageAddress } from "./page-registry.js";

export interface ResolvedPage extends PageInstance {
  landingPath: string;
  cookieKey: string;
}
interface Login {
  promise: Promise<string>;
  signal: AbortSignal;
  ready: boolean;
  retried: boolean;
  retry?: Promise<string>;
}
/** One authenticated entry fetch per phone and server instance; no sign-in secret leaves the computer. */
class PageLogins {
  private readonly phones = new Map<string, Map<string, Login>>();
  constructor(private readonly jars: CookieJars) {}
  private entries(fp: string): Map<string, Login> {
    let entries = this.phones.get(fp);
    if (!entries) {
      entries = new Map();
      this.phones.set(fp, entries);
    }
    return entries;
  }
  async initial(instance: PageInstance, fp: string, signal: AbortSignal): Promise<string> {
    if (!instance.entryURL) return instance.path;
    const entries = this.entries(fp),
      old = entries.get(instance.key);
    if (old && (old.ready || !old.signal.aborted)) return old.promise;
    const login: Login = { promise: Promise.resolve("/"), signal, ready: false, retried: false };
    login.promise = this.authenticate(instance, this.jars.jar(fp, instance.key), signal)
      .then((path) => {
        login.ready = true;
        return path;
      })
      .catch((e) => {
        if (entries.get(instance.key) === login) entries.delete(instance.key);
        throw e;
      });
    entries.set(instance.key, login);
    return login.promise;
  }
  retry(instance: PageInstance, fp: string, signal: AbortSignal): Promise<string> | null {
    if (!instance.entryURL) return null;
    const login = this.phones.get(fp)?.get(instance.key);
    if (!login?.ready) return null;
    if (login.retry) return login.retry;
    if (login.retried) return null;
    login.retried = true;
    const result = this.authenticate(instance, this.jars.jar(fp, instance.key), signal);
    login.retry = result.finally(() => {
      login.retry = undefined;
    });
    return login.retry;
  }
  ended(key: string): void {
    for (const entries of this.phones.values()) entries.delete(key);
    this.jars.dropScope(key);
  }
  retain(fps: ReadonlySet<string>): void {
    for (const fp of this.phones.keys()) if (!fps.has(fp)) this.phones.delete(fp);
  }
  private async authenticate(
    instance: PageInstance,
    jar: CookieJar,
    signal: AbortSignal,
  ): Promise<string> {
    let current = instance.entryURL!,
      redirected = false;
    const deadline = Date.now() + 15000;
    for (let count = 0; count < 8; count++) {
      if (signal.aborted) throw new PageStartError("closed");
      const address = pageAddress(current);
      if (!address)
        throw new PageStartError("start-failed", "Its sign-in address isn't supported.");
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new PageStartError("timeout");
      const reply = await entryRequest(
        address.origin,
        address.path,
        jar,
        signal,
        Math.min(10000, remaining),
      );
      if ([301, 302, 303, 307, 308].includes(reply.status) && reply.location) {
        const next = new URL(reply.location, current).href;
        if (
          !pageAddress(next) ||
          !sameLocalPage(instance.origin, reply.family, pageAddress(next)!.origin)
        )
          throw new PageStartError("start-failed", "Its sign-in address isn't supported.");
        current = next;
        redirected = true;
        continue;
      }
      const url = new URL(current);
      if (reply.status === 200 && ((redirected && !url.search) || reply.cookies))
        return url.pathname;
      throw new PageStartError("start-failed", "Its sign-in address isn't supported.");
    }
    throw new PageStartError("start-failed", "Its sign-in address redirects too many times.");
  }
}
async function entryRequest(
  origin: PageInstance["origin"],
  path: string,
  jar: CookieJar,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<{ status: number; location?: string; cookies: boolean; family: 4 | 6 }> {
  const addresses = connectAddresses(origin.host);
  for (let index = 0; index < addresses.length; index++) {
    const address = addresses[index]!;
    try {
      return await new Promise((resolve, reject) => {
        const cookies = jar.matching(path, Date.now());
        const req = http.request(
          {
            host: address.address,
            port: origin.port,
            family: address.family,
            method: "GET",
            path,
            headers: {
              Host: origin.authority,
              ...(cookies.length
                ? { Cookie: cookies.map(([k, v]) => `${k}=${v}`).join("; ") }
                : {}),
            },
            setHost: false,
            maxHeaderSize: 16384,
          },
          (res) => {
            cleanup();
            if (signal.aborted) {
              res.destroy();
              reject(new PageStartError("closed"));
              return;
            }
            const set = res.headers["set-cookie"] ?? [];
            for (const cookie of set) jar.store(cookie, path, Date.now());
            resolve({
              status: res.statusCode ?? 502,
              ...(res.headers.location && { location: res.headers.location }),
              cookies: set.length > 0,
              family: address.family,
            });
            res.destroy();
          },
        );
        const abort = () => req.destroy(new PageStartError("closed"));
        const timer = setTimeout(() => req.destroy(new PageStartError("timeout")), timeoutMs);
        timer.unref();
        const cleanup = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", abort);
        };
        signal.addEventListener("abort", abort, { once: true });
        req.on("error", (error) => {
          cleanup();
          reject(error);
        });
        if (signal.aborted) abort();
        else req.end();
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ECONNREFUSED" && index + 1 < addresses.length)
        continue;
      if (error instanceof PageStartError) throw error;
      throw new PageStartError("unreachable");
    }
  }
  throw new PageStartError("unreachable");
}
export interface PageHostOptions
  extends Omit<PageRegistryOptions, "changed">,
    Omit<PageProcessOptions, "home" | "ended"> {
  jars: CookieJars;
  changed?: () => void;
}
/** Generic registered pages. This module knows nothing about the tools that register them. */
export class PageHost {
  readonly registry: PageRegistry;
  private readonly processes: PageProcesses;
  private readonly logins: PageLogins;
  private readonly viewing = new Map<string, Set<string>>();
  constructor(options: PageHostOptions) {
    this.logins = new PageLogins(options.jars);
    this.registry = new PageRegistry({
      ...options,
      changed: () => {
        this.processes.reconcile();
        options.changed?.();
      },
    });
    this.processes = new PageProcesses(this.registry, {
      ...options,
      ended: (key) => this.logins.ended(key),
    });
  }
  get entries(): readonly WebPage[] {
    return this.registry.entries;
  }
  start(): Promise<void> {
    return this.registry.start();
  }
  view(page: string, viewer: string, open: boolean): void {
    if (open && !this.registry.get(page)) return;
    let ids = this.viewing.get(viewer);
    if (open) {
      if (!ids) {
        ids = new Set();
        this.viewing.set(viewer, ids);
      }
      ids.add(page);
    } else {
      ids?.delete(page);
      if (!ids?.size) this.viewing.delete(viewer);
    }
    this.processes.view(page, viewer, open);
  }
  leave(viewer: string): void {
    this.viewing.delete(viewer);
    this.processes.leave(viewer);
  }
  async resolve(
    page: string,
    viewer: string,
    phone: string,
    signal: AbortSignal,
  ): Promise<ResolvedPage> {
    if (!this.viewing.get(viewer)?.has(page)) throw new PageStartError("refused");
    await this.registry.refresh();
    const instance = await this.processes.resolve(page);
    if (signal.aborted || !this.processes.current(instance)) throw new PageStartError("closed");
    const landingPath = await this.logins.initial(instance, phone, signal);
    if (signal.aborted || !this.processes.current(instance)) throw new PageStartError("closed");
    return { ...instance, landingPath, cookieKey: instance.key };
  }
  current(instance: ResolvedPage): boolean {
    return this.processes.current(instance);
  }
  retry(instance: ResolvedPage, phone: string, signal: AbortSignal): Promise<string> | null {
    if (!this.processes.current(instance)) return null;
    return this.logins.retry(instance, phone, signal);
  }
  icon(page: string, hash: string): Uint8Array | undefined {
    const icon = this.registry.get(page)?.icon;
    return icon?.hash === hash ? icon.bytes : undefined;
  }
  retainPhones(fps: ReadonlySet<string>): void {
    this.logins.retain(fps);
  }
  async close(): Promise<void> {
    this.registry.close();
    await this.processes.close();
  }
}
