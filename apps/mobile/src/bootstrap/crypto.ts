import { getRandomValues } from "expo-crypto";

const g = globalThis as { crypto?: { getRandomValues?: unknown } };
if (!g.crypto) g.crypto = {};
if (typeof g.crypto.getRandomValues !== "function") {
  g.crypto.getRandomValues = getRandomValues as unknown;
}
const probe = new Uint8Array(8);
(g.crypto.getRandomValues as (a: Uint8Array) => Uint8Array)(probe);
if (probe.every((b) => b === 0)) throw new Error("secure randomness unavailable");
