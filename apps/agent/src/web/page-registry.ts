import { createHash } from "node:crypto";
import {
  accessSync,
  chmodSync,
  closeSync,
  constants,
  type FSWatcher,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  type Stats,
  watch,
} from "node:fs";
import { userInfo } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { crc32 } from "node:zlib";
import {
  classifyWebLink,
  type LocalOrigin,
  WEB_LIMITS,
  type WebPage,
  WebPageIdSchema,
} from "@shellbell/protocol";
import { z } from "zod";
import { runServiceCommand } from "../service-command.js";

const text = (limit: number) =>
  z
    .string()
    .min(1)
    .max(limit)
    .refine((s) => !/\p{Cc}/u.test(s));
const path = text(4096).refine(isAbsolute);
const registration = z
  .object({
    shellbell: z.literal(1),
    name: text(40),
    description: text(120).optional(),
    start: z.array(text(4096)).min(1).max(64).optional(),
    cwd: path.optional(),
    url: text(8192).optional(),
    icon: z.unknown().optional(),
  })
  .refine((p) => (p.start !== undefined) !== (p.url !== undefined), "Choose start or url")
  .refine((p) => !p.cwd || p.start !== undefined, "cwd requires start")
  .refine((p) => !p.start || isAbsolute(p.start[0]!), "The program must have an absolute path");

export interface PageAddress {
  origin: LocalOrigin;
  path: string;
  url: string;
}
export function pageAddress(value: string): PageAddress | null {
  try {
    const parsed = new URL(value);
    const link = classifyWebLink(value);
    if (link.kind !== "local" || parsed.username || parsed.password) return null;
    return {
      origin: link.origin,
      path: parsed.pathname + parsed.search,
      url: link.origin.origin + parsed.pathname + parsed.search,
    };
  } catch {
    return null;
  }
}
export interface PageRegistration {
  id: string;
  name: string;
  description?: string;
  start?: string[];
  cwd?: string;
  url?: PageAddress;
  /** Changes to the registration retire the server; icon-only edits do not. */
  revision: string;
  icon?: { hash: string; bytes: Uint8Array };
}
export class PageRegistrationError extends Error {
  constructor(
    readonly reason: string,
    readonly fix?: string,
  ) {
    super(reason);
  }
}
export interface PageRegistryOptions {
  home: string;
  create?: boolean;
  uid?: number;
  username?: string;
  platform?: NodeJS.Platform;
  /** Tests supply metadata instead of consulting the release machine's ACLs. */
  acl?: (path: string) => Promise<string>;
  changed?: () => void;
}
const writableACL = new Set([
  "write",
  "append",
  "delete",
  "delete_child",
  "add_file",
  "add_subdirectory",
  "writeattr",
  "writeextattr",
  "writesecurity",
  "chown",
]);
export function hasForeignWriteACL(listing: string, uid: number, username: string): boolean {
  for (const line of listing.split("\n")) {
    if (!/^\s*\d+:/.test(line) || !/\ballow\b/.test(line)) continue;
    const match = /^\s*\d+:\s+(user|group):(.+?)\s+(?:inherited\s+)?allow\s+(.+)$/.exec(line);
    if (!match) return true;
    if (!match[3]!.split(/[,\s]+/).some((right) => writableACL.has(right))) continue;
    if (match[1] !== "user" || ![String(uid), username].includes(match[2]!)) return true;
  }
  return false;
}
/** Validate the complete bounded PNG container before handing bytes to the phone's image decoder. */
export function validPagePNG(bytes: Uint8Array): boolean {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    b.length < 57 ||
    b.length > WEB_LIMITS.iconBytes ||
    !b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return false;
  let at = 8,
    image = false,
    first = true;
  while (at + 12 <= b.length) {
    const size = b.readUInt32BE(at),
      end = at + 12 + size;
    if (end > b.length) return false;
    const kind = b.toString("ascii", at + 4, at + 8);
    if (
      !/^[A-Za-z]{4}$/.test(kind) ||
      crc32(b.subarray(at + 4, end - 4)) !== b.readUInt32BE(end - 4)
    )
      return false;
    if (first) {
      if (kind !== "IHDR" || size !== 13) return false;
      const w = b.readUInt32BE(at + 8),
        h = b.readUInt32BE(at + 12);
      if (
        !w ||
        w !== h ||
        w > WEB_LIMITS.iconDimension ||
        b[at + 18] !== 0 ||
        b[at + 19] !== 0 ||
        b[at + 20]! > 1
      )
        return false;
      first = false;
    } else if (kind === "IHDR") return false;
    if (kind === "IDAT") image = true;
    if (kind === "IEND") return size === 0 && image && end === b.length;
    at = end;
  }
  return false;
}

class MissingPages extends Error {}
export class PageRegistry {
  readonly directory: string;
  private readonly uid: number;
  private readonly username: string;
  private readonly platform: NodeJS.Platform;
  private readonly acl: (path: string) => Promise<string>;
  private records = new Map<string, PageRegistration>();
  private rows: WebPage[] = [];
  private problems: string[] = [];
  private watcher?: FSWatcher;
  private watched?: string;
  private poll?: ReturnType<typeof setInterval>;
  private debounce?: ReturnType<typeof setTimeout>;
  private refreshing?: Promise<void>;
  private closed = false;
  constructor(private readonly options: PageRegistryOptions) {
    this.directory = join(options.home, ".config/shellbell/apps");
    this.uid = options.uid ?? process.getuid!();
    this.username = options.username ?? userInfo().username;
    this.platform = options.platform ?? process.platform;
    this.acl =
      options.acl ??
      (async (p) => {
        const result = await runServiceCommand("/bin/ls", ["-ldne", p], {
          timeoutMs: 3000,
          maxOutputBytes: 65536,
          captureOutput: true,
        });
        if (result.exitCode !== 0)
          throw new PageRegistrationError("File permissions could not be checked.");
        return result.stdout.toString("utf8");
      });
  }
  get entries(): readonly WebPage[] {
    return this.rows;
  }
  get issues(): readonly string[] {
    return this.problems;
  }
  get(id: string): PageRegistration | undefined {
    return this.records.get(id);
  }
  async start(): Promise<void> {
    await this.refresh();
    if (!this.closed && !this.poll) {
      this.poll = setInterval(() => void this.refresh(), 5000);
      this.poll.unref();
    }
  }
  close(): void {
    this.closed = true;
    this.watcher?.close();
    if (this.poll) clearInterval(this.poll);
    if (this.debounce) clearTimeout(this.debounce);
  }
  async refresh(): Promise<void> {
    if (this.closed) return;
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.scan().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }
  private label(p: string): string {
    const home = realpathSync(this.options.home);
    return p === home ? "~" : p.startsWith(home + "/") ? "~" + p.slice(home.length) : p;
  }
  private async trust(p: string, cache = new Map<string, Promise<void>>()): Promise<void> {
    const physical = realpathSync(p),
      home = realpathSync(this.options.home);
    let current = physical;
    for (;;) {
      const checked = current;
      let check = cache.get(checked);
      if (!check) {
        check = (async () => {
          const st = lstatSync(checked);
          const belowHome =
            relative(home, checked) === "" ||
            (!relative(home, checked).startsWith("..") && !isAbsolute(relative(home, checked)));
          const label = this.label(checked);
          if (
            !st.isDirectory() ||
            st.isSymbolicLink() ||
            (st.uid !== this.uid && (belowHome || st.uid !== 0))
          )
            throw new PageRegistrationError("An application folder has an unexpected owner.");
          if (st.mode & 0o022) {
            const mode = st.mode & 0o002 ? "go-w" : "g-w";
            const quoted =
              checked === realpathSync(join(this.options.home, ".config"))
                ? "~/.config"
                : "'" + checked.replaceAll("'", "'\\''") + "'";
            throw new PageRegistrationError(
              `${label} can be changed by other users.`.slice(0, 120),
              `chmod ${mode} ${quoted}`.slice(0, 120),
            );
          }
          if (
            this.platform === "darwin" &&
            hasForeignWriteACL(await this.acl(checked), this.uid, this.username)
          )
            throw new PageRegistrationError(
              `${label} grants write access to another user.`.slice(0, 120),
              "Remove its write, append or delete allow ACL entries.",
            );
        })();
        cache.set(checked, check);
      }
      await check;
      if (current === home || current === dirname(current)) break;
      current = dirname(current);
    }
  }
  private async prepare(cache: Map<string, Promise<void>>): Promise<string> {
    const config = join(this.options.home, ".config");
    if (this.options.create === false) {
      for (const p of [config, join(config, "shellbell"), this.directory]) {
        try {
          lstatSync(p);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new MissingPages();
          throw error;
        }
        await this.trust(p, cache);
      }
      return realpathSync(this.directory);
    }
    try {
      lstatSync(config);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      mkdirSync(config, { mode: 0o700 });
    }
    await this.trust(config, cache);
    for (const p of [join(config, "shellbell"), this.directory]) {
      try {
        lstatSync(p);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        mkdirSync(p, { mode: 0o700 });
      }
      const real = realpathSync(p),
        st = lstatSync(real);
      if (!st.isDirectory() || st.uid !== this.uid)
        throw new PageRegistrationError("The applications folder must belong to you.");
      chmodSync(real, 0o700);
      await this.trust(p, cache);
    }
    return realpathSync(this.directory);
  }
  private async read(p: string, limit: number, cache: Map<string, Promise<void>>): Promise<Buffer> {
    await this.trust(dirname(p), cache);
    const check = (s: Stats) => {
      if (!s.isFile() || s.isSymbolicLink() || s.uid !== this.uid || s.mode & 0o022)
        throw new PageRegistrationError(
          "The file must belong to you and not be writable by other users.",
        );
      if (s.size > limit) throw new PageRegistrationError("The file is too large.");
    };
    const before = lstatSync(p);
    check(before);
    if (
      this.platform === "darwin" &&
      hasForeignWriteACL(await this.acl(p), this.uid, this.username)
    )
      throw new PageRegistrationError("The file grants write access to another user.");
    const fd = openSync(p, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = fstatSync(fd);
      check(opened);
      if (opened.dev !== before.dev || opened.ino !== before.ino)
        throw new PageRegistrationError("The file changed while it was read.");
      const bytes = Buffer.alloc(limit + 1);
      let count = 0;
      while (count < bytes.length) {
        const n = readSync(fd, bytes, count, bytes.length - count, null);
        if (!n) break;
        count += n;
      }
      const after = fstatSync(fd);
      check(after);
      const current = lstatSync(p);
      check(current);
      if (
        count > limit ||
        after.dev !== current.dev ||
        after.ino !== current.ino ||
        after.size !== count ||
        after.mtimeMs !== opened.mtimeMs
      )
        throw new PageRegistrationError("The file changed while it was read.");
      return bytes.subarray(0, count);
    } finally {
      closeSync(fd);
    }
  }
  private async scan(): Promise<void> {
    const records = new Map<string, PageRegistration>(),
      rows: WebPage[] = [],
      problems: string[] = [];
    const cache = new Map<string, Promise<void>>();
    try {
      const real = await this.prepare(cache);
      if (this.closed) return;
      if (this.watched !== real) {
        this.watcher?.close();
        this.watched = real;
        try {
          this.watcher = watch(real, () => {
            if (this.debounce) clearTimeout(this.debounce);
            this.debounce = setTimeout(() => void this.refresh(), 60);
            this.debounce.unref();
          });
          this.watcher.on("error", () => {
            this.watcher?.close();
            this.watcher = undefined;
            this.watched = undefined;
          });
        } catch {
          this.watched = undefined;
        }
      }
      const files = readdirSync(real)
        .filter((name) => name.endsWith(".json"))
        .sort();
      if (files.length > WEB_LIMITS.pages)
        problems.push(`Only the first ${WEB_LIMITS.pages} registration files are listed.`);
      for (const file of files.slice(0, WEB_LIMITS.pages)) {
        const stem = file.slice(0, -5);
        const validID = WebPageIdSchema.safeParse(stem);
        const id = validID.success
          ? validID.data
          : `invalid-${createHash("sha256").update(file).digest("hex").slice(0, 24)}`;
        let row: WebPage = {
          id,
          name: stem.replace(/\p{Cc}/gu, "?").slice(0, 40) || "Invalid registration",
        };
        try {
          if (!validID.success)
            throw new PageRegistrationError(
              "Use a file name of 1–32 lowercase letters, digits or hyphens.",
            );
          const raw = await this.read(join(real, file), 16384, cache);
          const parsed = registration.safeParse(JSON.parse(raw.toString("utf8")));
          if (!parsed.success)
            throw new PageRegistrationError(
              "The registration needs version 1, a name and either start or url.",
            );
          const value = parsed.data;
          row = {
            id,
            name: value.name,
            ...(value.description && { description: value.description }),
          };
          let url: PageAddress | undefined;
          if (value.url) {
            url = pageAddress(value.url) ?? undefined;
            if (!url)
              throw new PageRegistrationError(
                "Only HTTP addresses on this computer's loopback are supported.",
              );
            row.address = url.origin.authority;
          }
          if (value.start) {
            try {
              accessSync(value.start[0]!, constants.F_OK);
            } catch (e) {
              if ((e as NodeJS.ErrnoException).code === "ENOENT") {
                problems.push(`${value.name}: the registered program is no longer installed.`);
                continue;
              }
              throw e;
            }
            try {
              accessSync(value.start[0]!, constants.X_OK);
            } catch {
              throw new PageRegistrationError("The registered program cannot be executed.");
            }
          }
          if (value.cwd) await this.trust(value.cwd, cache);
          const record: PageRegistration = {
            id,
            name: value.name,
            ...(value.description && { description: value.description }),
            ...(value.start && { start: value.start }),
            ...(value.cwd && { cwd: realpathSync(value.cwd) }),
            ...(url && { url }),
            revision: createHash("sha256")
              .update(JSON.stringify({ ...value, icon: undefined }))
              .digest("hex"),
          };
          if (value.icon !== undefined) {
            try {
              if (!path.safeParse(value.icon).success)
                throw new PageRegistrationError("The icon needs an absolute PNG path.");
              const bytes = await this.read(value.icon as string, WEB_LIMITS.iconBytes, cache);
              if (!validPagePNG(bytes))
                throw new PageRegistrationError(
                  "Use a square PNG, at most 64 KB and 1024 pixels wide.",
                );
              record.icon = { hash: createHash("sha256").update(bytes).digest("hex"), bytes };
              row.icon = record.icon.hash;
            } catch (e) {
              row.iconIssue = this.issue(e, "The page icon could not be read.");
            }
          }
          records.set(id, record);
        } catch (e) {
          row.skipped = this.issue(e, "The registration could not be read.");
        }
        rows.push(row);
      }
    } catch (e) {
      if (!(e instanceof MissingPages)) {
        const issue = this.issue(e, "The applications folder could not be read.");
        rows.push({ id: "shellbell-pages", name: "Pages", skipped: issue });
        problems.push(issue.reason);
      }
    }
    if (this.closed) return;
    rows.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    const changed =
      JSON.stringify(rows) !== JSON.stringify(this.rows) ||
      JSON.stringify(problems) !== JSON.stringify(this.problems) ||
      [...records].some(([id, r]) => this.records.get(id)?.revision !== r.revision) ||
      records.size !== this.records.size;
    this.records = records;
    this.rows = rows;
    this.problems = problems;
    if (changed) this.options.changed?.();
  }
  private issue(error: unknown, fallback: string): { reason: string; fix?: string } {
    return error instanceof PageRegistrationError
      ? { reason: error.reason, ...(error.fix && { fix: error.fix }) }
      : { reason: fallback };
  }
}
