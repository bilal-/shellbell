import { describe, expect, it } from "vitest";
import { QueueBudget } from "../src/queue-budget.js";

describe("QueueBudget", () => {
  it("admits the exact connection limit and rejects one extra byte", () => {
    const budget = new QueueBudget(10, 30);
    expect(budget.reserve("a", 10)).toBe(true);
    expect(budget.reserve("a", 1)).toBe(false);
    budget.release("a", 1);
    expect(budget.reserve("a", 1)).toBe(true);
  });
  it("shares the global cap across recipients without leaking rejected reservations", () => {
    const budget = new QueueBudget(10, 15);
    expect(budget.reserve("a", 10)).toBe(true);
    expect(budget.reserve("b", 6)).toBe(false);
    expect(budget.reserve("b", 5)).toBe(true);
    expect(budget.reserve("c", 1)).toBe(false);
    budget.drop("a");
    expect(budget.reserve("c", 10)).toBe(true);
  });
  it("cannot release another recipient's bytes after repeated release or close", () => {
    const budget = new QueueBudget(10, 10);
    budget.reserve("a", 5);
    budget.reserve("b", 5);
    budget.drop("a");
    budget.drop("a");
    budget.release("a", 5);
    expect(budget.reserve("c", 6)).toBe(false);
    expect(budget.reserve("c", 5)).toBe(true);
    budget.release("b", 99);
    budget.release("b", 99);
    expect(budget.reserve("d", 6)).toBe(false);
  });
  it("rejects invalid counts instead of corrupting accounting", () => {
    const budget = new QueueBudget(10, 20);
    for (const bytes of [-1, 0.5, NaN, Infinity]) {
      expect(() => budget.reserve("a", bytes)).toThrow();
      expect(() => budget.release("a", bytes)).toThrow();
    }
    expect(budget.reserve("a", 10)).toBe(true);
  });
});
