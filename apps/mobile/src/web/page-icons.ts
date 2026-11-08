import {
  sha256,
  toBase64Url,
  WEB_LIMITS,
  type WebMessageOf,
  type WebPage,
  WebPagesSchema,
} from "@shellbell/protocol";
import type { WebSession } from "./web-session";

interface Pending {
  page: string;
  hash: string;
  bytes?: Uint8Array;
  received: number;
  total?: number;
  cancel?: () => void;
  timer?: ReturnType<typeof setTimeout>;
}
/** Icons are in-memory metadata: bounded, hash-verified and requested once per current image. */
export class PageIcons {
  private pages: readonly WebPage[] = [];
  private images = new Map<string, string>();
  private failed = new Set<string>();
  private pending: Pending | null = null;
  private paused = false;
  constructor(
    private readonly options: {
      session: () => WebSession | null;
      changed: (icons: Record<string, string>) => void;
      timeoutMs?: number;
    },
  ) {}
  sync(input: unknown): void {
    const parsed = WebPagesSchema.safeParse(input);
    this.pages = parsed.success ? parsed.data : [];
    const active = new Set(
      this.pages.map((p) => p.icon).filter((v): v is string => v !== undefined),
    );
    for (const hash of this.images.keys()) if (!active.has(hash)) this.images.delete(hash);
    for (const hash of this.failed) if (!active.has(hash)) this.failed.delete(hash);
    if (
      this.pending &&
      !this.pages.some((p) => p.id === this.pending!.page && p.icon === this.pending!.hash)
    )
      this.cancelPending();
    this.paused = false;
    this.publish();
    this.pump();
  }
  pause(): void {
    this.paused = true;
    this.cancelPending();
    this.failed.clear();
  }
  clear(): void {
    this.pause();
    this.pages = [];
    this.images.clear();
    this.publish();
  }
  private publish(): void {
    this.options.changed(Object.fromEntries(this.images));
  }
  private cancelPending(): void {
    const pending = this.pending;
    this.pending = null;
    if (pending?.timer) clearTimeout(pending.timer);
    pending?.cancel?.();
  }
  private finish(pending: Pending, uri?: string): void {
    if (this.pending !== pending) return;
    this.cancelPending();
    if (uri) this.images.set(pending.hash, uri);
    else this.failed.add(pending.hash);
    this.publish();
    this.pump();
  }
  private pump(): void {
    if (this.paused || this.pending) return;
    const page = this.pages.find(
      (p) => p.icon && !p.skipped && !this.images.has(p.icon) && !this.failed.has(p.icon),
    );
    if (!page?.icon) return;
    const session = this.options.session();
    if (!session) return;
    const pending: Pending = { page: page.id, hash: page.icon, received: 0 };
    this.pending = pending;
    pending.timer = setTimeout(() => this.finish(pending), this.options.timeoutMs ?? 10000);
    const cancel = session.icon(page.id, page.icon, (frame) => {
      if (this.pending !== pending) return;
      if (
        !frame?.bytes ||
        frame.offset !== pending.received ||
        frame.total === undefined ||
        frame.total < 1 ||
        frame.total > WEB_LIMITS.iconBytes ||
        (pending.total !== undefined && frame.total !== pending.total) ||
        frame.bytes.byteLength > WEB_LIMITS.iconChunkBytes ||
        pending.received + frame.bytes.byteLength > frame.total
      ) {
        this.finish(pending);
        return;
      }
      if (!pending.bytes) {
        pending.total = frame.total;
        pending.bytes = new Uint8Array(frame.total);
      }
      pending.bytes.set(frame.bytes, pending.received);
      pending.received += frame.bytes.byteLength;
      if (pending.received !== pending.total) return;
      const bytes = pending.bytes;
      const hash = [...sha256(bytes)].map((n) => n.toString(16).padStart(2, "0")).join("");
      if (hash !== pending.hash || !iconHeader(bytes)) {
        this.finish(pending);
        return;
      }
      const encoded = toBase64Url(bytes).replaceAll("-", "+").replaceAll("_", "/");
      this.finish(
        pending,
        `data:image/png;base64,${encoded}${"=".repeat((4 - (encoded.length % 4)) % 4)}`,
      );
    });
    if (this.pending === pending) pending.cancel = cancel;
    else cancel();
  }
}
function iconHeader(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 33 || ![137, 80, 78, 71, 13, 10, 26, 10].every((n, i) => bytes[i] === n))
    return false;
  const d = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (d.getUint32(8) !== 13 || String.fromCharCode(...bytes.subarray(12, 16)) !== "IHDR")
    return false;
  const w = d.getUint32(16),
    h = d.getUint32(20);
  return w > 0 && w === h && w <= WEB_LIMITS.iconDimension;
}
