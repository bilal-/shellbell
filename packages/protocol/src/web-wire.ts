import { z } from "zod";
import { encodeCbor } from "./codec.js";
import { Bytes } from "./envelope.js";

/** In `hello.features`: this computer serves local web pages to the phone. */
export const WEB_FEATURE = "web-v1";

export const WEB_LIMITS = {
  /** Bytes in flight per phone and direction, counted with `webCharge`. */
  connectionWindow: 131_072,
  /** Body bytes in flight per stream before the receiver returns credit. */
  streamWindow: 131_072,
  /** Covers the route wrapper, tag and envelope, so tiny frames can't overrun the channel. */
  frameAllowance: 256,
  dataBytes: 16_384,
  headHeaderBytes: 16_384,
  headPairs: 128,
  headBodyBytes: 4_096,
  /** `web.open`'s path and headers together. */
  openBytes: 24_576,
  pathBytes: 8_192,
  originBytes: 256,
  /** Credit is returned once this much has built up, or `creditFlushMs` after the first byte. */
  creditFlushBytes: 8_192,
  creditFlushMs: 20,
  streamsPerPhone: 24,
  detailChars: 120,
} as const;

const u32 = z.number().int().min(0).max(0xffff_ffff);
export const WebStreamIdSchema = u32.min(1);
export const WebPageIdSchema = z.string().regex(/^[a-z0-9-]{1,32}$/);
const token = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/);

export const WebTargetSchema = z.union([
  z.strictObject({ page: WebPageIdSchema }),
  z.strictObject({ origin: z.string().min(1).max(WEB_LIMITS.originBytes) }),
]);
export type WebTarget = z.infer<typeof WebTargetSchema>;

/** Header values are bytes: HTTP allows obs-text, and nothing here should reinterpret it. */
export const WebHeaderSchema = z.tuple([token, Bytes()]);
export type WebHeader = z.infer<typeof WebHeaderSchema>;

const headerBytes = (headers: readonly WebHeader[]) =>
  headers.reduce((sum, [name, value]) => sum + name.length + value.byteLength + 4, 0);

export const WebResetReasonSchema = z.enum([
  "refused",
  "unreachable",
  "timeout",
  "too-large",
  "locked",
  "closed",
  "not-found",
  "start-failed",
  "start-timeout",
]);
export type WebResetReason = z.infer<typeof WebResetReasonSchema>;

const printable = z
  .string()
  .min(1)
  .max(WEB_LIMITS.detailChars)
  .refine((value) => [...value].every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127));

export const WebAuthoritySchema = z.strictObject({
  /** The authority the page was opened with, such as `localhost:5173`. */
  authority: z.string().min(1).max(WEB_LIMITS.originBytes),
  /** The address family that answered. */
  family: z.union([z.literal(4), z.literal(6)]),
});

export const WebMessageSchema = z.discriminatedUnion("type", [
  z
    .strictObject({
      type: z.literal("web.open"),
      stream: WebStreamIdSchema,
      target: WebTargetSchema,
      method: token.max(16),
      path: z.string().min(1).max(WEB_LIMITS.pathBytes).startsWith("/"),
      headers: z.array(WebHeaderSchema).max(WEB_LIMITS.headPairs),
      body: z.boolean(),
      upgrade: z.boolean(),
    })
    .refine(
      (open) => open.path.length + headerBytes(open.headers) <= WEB_LIMITS.openBytes,
      "web.open path and headers too large",
    ),
  z
    .strictObject({
      type: z.literal("web.head"),
      stream: WebStreamIdSchema,
      status: z.number().int().min(101).max(599),
      headers: z.array(WebHeaderSchema).max(WEB_LIMITS.headPairs),
      bytes: Bytes()
        .refine((value) => value.byteLength <= WEB_LIMITS.headBodyBytes)
        .optional(),
      end: z.boolean().optional(),
      authority: WebAuthoritySchema.optional(),
    })
    .refine((head) => head.status === 101 || head.status >= 200, "web.head status")
    .refine(
      (head) => headerBytes(head.headers) <= WEB_LIMITS.headHeaderBytes,
      "web.head headers too large",
    ),
  z.strictObject({
    type: z.literal("web.data"),
    stream: WebStreamIdSchema,
    bytes: Bytes().refine(
      (value) => value.byteLength > 0 && value.byteLength <= WEB_LIMITS.dataBytes,
    ),
  }),
  z.strictObject({ type: z.literal("web.end"), stream: WebStreamIdSchema }),
  /** `stream: 0` returns connection credit; any other stream returns that stream's body credit. */
  z.strictObject({ type: z.literal("web.credit"), stream: u32, bytes: u32.min(1) }),
  z.strictObject({
    type: z.literal("web.reset"),
    stream: WebStreamIdSchema,
    reason: WebResetReasonSchema,
    detail: printable.optional(),
  }),
  z.strictObject({ type: z.literal("web.view"), target: WebTargetSchema, open: z.boolean() }),
]);
export type WebMessage = z.infer<typeof WebMessageSchema>;
export type WebMessageOf<T extends WebMessage["type"]> = Extract<WebMessage, { type: T }>;

/** The frames that spend connection credit. Others only acknowledge, end or reduce. */
export const WEB_CHARGED_TYPES = ["web.open", "web.head", "web.data"] as const;
export type WebChargedType = (typeof WEB_CHARGED_TYPES)[number];

export function isWebChargedType(type: unknown): type is WebChargedType {
  return (WEB_CHARGED_TYPES as readonly unknown[]).includes(type);
}

/** What a frame costs against the connection window, from its encoded inner CBOR length. */
export function webChargeForLength(innerBytes: number): number {
  return innerBytes + WEB_LIMITS.frameAllowance;
}

/** Both sides compute the same charge: the encoded inner message plus the framing allowance. */
export function webCharge(message: WebMessage): number {
  return isWebChargedType(message.type) ? webChargeForLength(encodeCbor(message).byteLength) : 0;
}

/** Body bytes a frame spends from its stream's window. */
export function webBodyBytes(message: WebMessage): number {
  if (message.type === "web.data") return message.bytes.byteLength;
  if (message.type === "web.head") return message.bytes?.byteLength ?? 0;
  return 0;
}

/** Headers removed on both sides; each hop frames its own connection. */
export const WEB_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
