import { ProtocolError } from "@shellbell/protocol";
import { expect, it } from "vitest";
import { legacyBudgetUsage } from "../src/notifications/policy.js";

it.each([
  { legacy: undefined, now: 3601000, want: 0 },
  { legacy: { count: 7, windowStart: 1000 }, now: 3600999, want: 7 },
  { legacy: { count: 7, windowStart: 1000 }, now: 3601000, want: 0 },
  { legacy: { count: 7, windowStart: 1000 }, now: 3601001, want: 0 },
  { legacy: { count: 25, windowStart: 1000 }, now: 1001, want: 25 },
])("preserves active legacy reservations: %j", ({ legacy, now, want }) => {
  expect(legacyBudgetUsage(legacy, [0, 1000], now)).toBe(want);
});

it.each([
  { count: -1, windowStart: 0 },
  { count: 1.5, windowStart: 0 },
  { count: 9007199254740992, windowStart: 0 },
  { count: "20", windowStart: 0 },
  { count: null, windowStart: 0 },
  { count: 1, windowStart: -1 },
  { count: 1, windowStart: 9007199254740992 },
  { count: 1, windowStart: "0" },
])("rejects corrupt legacy usage even when its window is expired: %j", (legacy) => {
  expect(() => legacyBudgetUsage(legacy, [1000], 4_000_000)).toThrow(ProtocolError);
});

it.each([-1, 1.5, 9007199254740992, NaN, Infinity, "1000", null, undefined])(
  "validates every attempt even without a legacy row: %s",
  (attempt) => {
    expect(() => legacyBudgetUsage(undefined, [1000, attempt], 4_000_000)).toThrow(ProtocolError);
  },
);
