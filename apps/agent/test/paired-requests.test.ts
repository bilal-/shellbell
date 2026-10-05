import type { InnerMessageOf } from "@shellbell/protocol";
import { describe, expect, it, vi } from "vitest";
import { PairedRequestLedger } from "../src/paired-requests.js";

type Ack = InnerMessageOf<"ack">;
const ok = (reqId: string): Ack => ({ type: "ack", reqId, ok: true });

describe("paired request admission", () => {
  it("reserves before a backend can synchronously submit a duplicate", async () => {
    const ledger = new PairedRequestLedger();
    const duplicate = vi.fn(async () => ok("same"));
    let joined: Promise<Ack> | undefined;
    const original = ledger.run("same", async () => {
      joined = ledger.run("same", duplicate);
      return ok("same");
    });
    expect(joined).toBe(original);
    expect(await joined).toEqual(ok("same"));
    expect(duplicate).not.toHaveBeenCalled();
  });

  it("retains an uncertain failure so another route cannot silently retry it", async () => {
    const ledger = new PairedRequestLedger();
    const effect = vi.fn(async () => {
      throw new Error("backend outcome lost");
    });
    expect(await ledger.run("uncertain", effect)).toMatchObject({
      ok: false,
      error: "delivery-unknown",
    });
    expect(await ledger.run("uncertain", effect)).toMatchObject({
      ok: false,
      error: "delivery-unknown",
    });
    expect(effect).toHaveBeenCalledTimes(1);
  });

  it("refuses new work at capacity while still joining every unfinished operation", async () => {
    const ledger = new PairedRequestLedger();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = Array.from({ length: 256 }, (_, index) =>
      ledger.run(`r${index}`, async () => {
        await gate;
        return ok(`r${index}`);
      }),
    );
    const overflow = vi.fn(async () => ok("overflow"));
    expect(await ledger.run("overflow", overflow)).toMatchObject({ ok: false, error: "busy" });
    expect(overflow).not.toHaveBeenCalled();
    expect(ledger.run("r0", overflow)).toBe(pending[0]);
    release();
    await Promise.all(pending);
    expect(await ledger.run("overflow", overflow)).toEqual(ok("overflow"));
    expect(overflow).toHaveBeenCalledTimes(1);
  });

  it("bounds completed outcomes without evicting unfinished work", async () => {
    const ledger = new PairedRequestLedger();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held = ledger.run("held", async () => {
      await gate;
      return ok("held");
    });
    for (let index = 0; index < 257; index += 1) {
      await ledger.run(`r${index}`, async () => ok(`r${index}`));
    }
    const duplicate = vi.fn(async () => ok("r256"));
    expect(await ledger.run("r256", duplicate)).toEqual(ok("r256"));
    expect(duplicate).not.toHaveBeenCalled();
    expect(ledger.run("held", duplicate)).toBe(held);
    const expired = vi.fn(async () => ok("r0"));
    await ledger.run("r0", expired);
    expect(expired).toHaveBeenCalledTimes(1);
    release();
    await held;
  });

  it("keeps the saved acknowledgement independent of the backend and caller", async () => {
    const ledger = new PairedRequestLedger();
    const outcome = ok("immutable");
    const received = await ledger.run("immutable", async () => outcome);
    outcome.ok = false;
    received.ok = false;
    expect(await ledger.run("immutable", async () => outcome)).toEqual(ok("immutable"));
  });
});
