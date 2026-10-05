import { runVectorChecks, type Vectors } from "@shellbell/protocol";
import { describe, expect, it } from "vitest";
import vectors from "../../../packages/protocol/test/vectors.json" with { type: "json" };

describe("golden vectors on workerd", () => {
  it("all pass", () => {
    expect(runVectorChecks(vectors as Vectors).filter((r) => !r.ok)).toEqual([]);
  });
});
