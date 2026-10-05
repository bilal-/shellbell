import { describe, expect, it } from "vitest";
import {
  type NotificationVectors,
  runNotificationVectorChecks,
  runVectorChecks,
  type Vectors,
} from "../src/vectors.js";
import notificationVectors from "./notification-vectors.json" with { type: "json" };
import vectors from "./vectors.json" with { type: "json" };

describe("golden vectors", () => {
  it("all checks pass in Node", () => {
    const results = runVectorChecks(vectors as Vectors);
    expect(results.length).toBe(10);
    expect(results.filter((r) => !r.ok)).toEqual([]);
  });
  it("checks the notification vectors independently of the unchanged streaming vectors", () => {
    const results = runNotificationVectorChecks(notificationVectors as NotificationVectors);
    expect(results.map((r) => r.name)).toContain("notification KDF");
    expect(results.map((r) => r.name)).toContain("notification decrypt");
    expect(results.filter((r) => !r.ok)).toEqual([]);
  });
});
