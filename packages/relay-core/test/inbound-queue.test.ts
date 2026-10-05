import { expect, it } from "vitest";
import { InboundQueue, QueueBudget } from "../src/index.js";

it("bounds handlers per connection, allowing another connection independently", () => {
  const queue = new InboundQueue(new QueueBudget(), 2);
  const first = queue.admit("a", 0)!;
  const second = queue.admit("a", 0)!;
  expect(queue.admit("a", 0)).toBeNull();
  const other = queue.admit("b", 0)!;
  first();
  first();
  const replacement = queue.admit("a", 0)!;
  expect(queue.admit("a", 0)).toBeNull();
  second();
  replacement();
  other();
});

it("holds shared byte credit until settlement and cannot double-refund a live handler", () => {
  const budget = new QueueBudget(520, 520);
  const queue = new InboundQueue(budget, 10);
  const old = queue.admit("closed", 4)!;
  const live = queue.admit("live", 4)!;
  expect(queue.admit("replacement", 4)).toBeNull();
  old();
  const replacement = queue.admit("replacement", 4)!;
  old();
  expect(queue.admit("another", 4)).toBeNull();
  live();
  replacement();
  expect(budget.reserve("all-refunded", 520)).toBe(true);
});

it("rejects invalid handler and frame limits", () => {
  for (const limit of [0, -1, 0.5, NaN, Infinity])
    expect(() => new InboundQueue(new QueueBudget(), limit)).toThrow(RangeError);
  const queue = new InboundQueue(new QueueBudget(), 1);
  for (const length of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER])
    expect(() => queue.admit("a", length)).toThrow(RangeError);
});
