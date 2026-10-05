import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { paths } from "../src/config.js";
import { NotificationState } from "../src/notification-state.js";

const phone = "a".repeat(26);
const generation = "AAAAAAAAAAAAAAAAAAAAAA";
const next = "AQEBAQEBAQEBAQEBAQEBAQ";
const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "shellbell-notify-state-"));
  roots.push(root);
  return paths(root);
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("durable notification reservations", () => {
  it("never dispatches through the previous generation and expires its metadata", () => {
    const p = fixture();
    let now = 1000;
    const state = new NotificationState(p, () => now);
    state.enroll(phone, generation);
    state.enroll(phone, next);
    expect(state.owns(phone, generation)).toBe(false);
    now += 300_000;
    expect(state.reserve(phone)?.generation).toBe(next);
    expect(
      JSON.parse(readFileSync(join(p.dir, "notifications.json"), "utf8")).phones[0].previous,
    ).toBeUndefined();
  });
  it("does not silently restart a deleted counter file for an old enrollment", () => {
    const p = fixture();
    const first = new NotificationState(p);
    first.enroll(phone, generation);
    expect(first.reserve(phone)?.sequence).toBe("1");
    rmSync(join(p.dir, "notifications.json"));
    const missing = new NotificationState(p);
    expect(missing.enroll(phone, generation)).toBe(false);
    expect(missing.reserve(phone)).toBeUndefined();
  });
  it("reserves before returning, survives reconstruction and preserves sequence across rotation", () => {
    const p = fixture();
    const state = new NotificationState(p);
    expect(state.reserve(phone)).toBeUndefined();
    expect(state.enroll(phone, generation)).toBe(true);
    expect(state.reserve(phone)).toEqual({ generation, sequence: "1" });
    const restart = new NotificationState(p);
    expect(restart.reserve(phone)).toEqual({ generation, sequence: "2" });
    expect(restart.enroll(phone, generation)).toBe(true);
    expect(restart.enroll(phone, next)).toBe(true);
    expect(restart.reserve(phone)).toEqual({ generation: next, sequence: "3" });
    expect(restart.enroll(phone, generation)).toBe(false);
    expect(statSync(join(p.dir, "notifications.json")).mode & 0o777).toBe(0o600);
    restart.forget(phone);
    expect(new NotificationState(p).reserve(phone)).toBeUndefined();
  });
  it("never resets corrupt counters or returns a reservation after a failed commit", () => {
    const p = fixture();
    writeFileSync(join(p.dir, "notifications.json"), "broken", { mode: 0o600 });
    const broken = new NotificationState(p);
    expect(broken.enroll(phone, generation)).toBe(false);
    expect(broken.reserve(phone)).toBeUndefined();
    expect(readFileSync(join(p.dir, "notifications.json"), "utf8")).toBe("broken");
    const other = fixture();
    const state = new NotificationState(other);
    state.enroll(phone, generation);
    writeFileSync(join(other.dir, `notifications.json.tmp-${process.pid}`), "occupied", {
      mode: 0o600,
    });
    expect(state.reserve(phone)).toBeUndefined();
    expect(state.reserve(phone)).toBeUndefined();
    expect(new NotificationState(other).reserve(phone)).toBeUndefined();
  });
  it("stops at the key-use bound and serializes concurrent reservation callers", async () => {
    const p = fixture();
    const state = new NotificationState(p);
    state.enroll(phone, generation);
    const results = await Promise.all(
      Array.from({ length: 8 }, () => Promise.resolve().then(() => state.reserve(phone))),
    );
    expect(results.map((r) => r?.sequence)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8"]);
    const file = join(p.dir, "notifications.json");
    const saved = JSON.parse(readFileSync(file, "utf8"));
    saved.phones[0].current.used = 2 ** 20;
    saved.phones[0].sequence = String(2 ** 20);
    writeFileSync(file, JSON.stringify(saved));
    const exhausted = new NotificationState(p);
    expect(exhausted.reserve(phone)).toBeUndefined();
    expect(exhausted.enroll(phone, generation)).toBe(false);
    expect(exhausted.enroll(phone, next)).toBe(true);
    expect(exhausted.reserve(phone)?.sequence).toBe(String(2 ** 20 + 1));
  });
});
