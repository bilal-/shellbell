import zlib from "node:zlib";

/**
 * Page traffic is limited by bytes per round trip (a 128 KB window), so fewer bytes is directly
 * faster. Dev servers such as Vite don't compress; the web host gzips their text on the computer
 * and the page view unpacks it natively.
 */

const TEXT_TYPES = [
  /^text\//,
  /^application\/(?:javascript|ecmascript|json|xml|xhtml\+xml|manifest\+json|wasm)$/,
  /^application\/[\w.+-]+\+(?:json|xml)$/,
  /^image\/svg\+xml$/,
];

/** Below this, gzip's header and a round trip's worth of framing aren't worth it. */
const MIN_BYTES = 1024;

const lower = (rawHeaders: readonly string[], name: string): string[] => {
  const out: string[] = [];
  for (let i = 0; i + 1 < rawHeaders.length; i += 2)
    if (rawHeaders[i]?.toLowerCase() === name) out.push(rawHeaders[i + 1] ?? "");
  return out;
};

export function acceptsGzip(acceptEncoding: string | undefined): boolean {
  if (!acceptEncoding) return false;
  return acceptEncoding.split(",").some((part) => {
    const [coding, ...params] = part.trim().toLowerCase().split(";");
    if (coding !== "gzip" && coding !== "*") return false;
    const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
    return q === undefined || Number(q.slice(2)) > 0;
  });
}

/** Whether the web host should gzip this response itself. */
export function shouldCompress(
  status: number,
  rawHeaders: readonly string[],
  acceptEncoding: string | undefined,
): boolean {
  // Only whole responses: never partial content, which would need ranges of the gzip stream.
  if (status !== 200 || !acceptsGzip(acceptEncoding)) return false;
  const encoding = lower(rawHeaders, "content-encoding").join(",").trim().toLowerCase();
  if (encoding !== "" && encoding !== "identity") return false;
  if (lower(rawHeaders, "content-range").length) return false;
  // Responses that set cookies can carry secrets beside reflected input (BREACH); leave them.
  if (lower(rawHeaders, "set-cookie").length) return false;
  if (lower(rawHeaders, "cache-control").some((v) => /no-transform/i.test(v))) return false;
  const type =
    (lower(rawHeaders, "content-type")[0] ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  // Server-sent events must arrive as they're written, not when a compressor flushes.
  if (type === "" || type === "text/event-stream") return false;
  if (!TEXT_TYPES.some((pattern) => pattern.test(type))) return false;
  const length = lower(rawHeaders, "content-length")[0];
  return length === undefined || Number(length) >= MIN_BYTES;
}

/**
 * The response's headers once gzipped: no length (the door chunks it), the encoding, `Vary`, and
 * a weak ETag, since the bytes no longer match a strong one.
 */
export function compressedHeaders(rawHeaders: readonly string[]): string[] {
  const out: string[] = [];
  let vary: string | null = null;
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    const name = rawHeaders[i] as string;
    const value = rawHeaders[i + 1] as string;
    const key = name.toLowerCase();
    if (key === "content-length" || key === "content-encoding") continue;
    if (key === "vary") {
      vary = vary ? `${vary}, ${value}` : value;
      continue;
    }
    if (key === "etag" && !value.startsWith("W/")) {
      out.push(name, `W/${value}`);
      continue;
    }
    out.push(name, value);
  }
  const varies = (vary ?? "")
    .toLowerCase()
    .split(",")
    .map((v) => v.trim());
  const nextVary =
    varies.includes("accept-encoding") || varies.includes("*")
      ? vary
      : vary
        ? `${vary}, Accept-Encoding`
        : "Accept-Encoding";
  out.push("Content-Encoding", "gzip", "Vary", nextVary as string);
  return out;
}

/** A fast setting: the link, not the computer's CPU, is the bottleneck. */
export function createGzip(): zlib.Gzip {
  return zlib.createGzip({ level: 5 });
}
