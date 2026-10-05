import { fromBase64Url, fromUtf8, toBase64Url, utf8 } from "@shellbell/protocol";

export const sidToRoute = (sid: string): string => toBase64Url(utf8(sid));
export const sidFromRoute = (s: string): string => fromUtf8(fromBase64Url(s));
