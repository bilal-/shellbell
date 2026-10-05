import { chmodSync, existsSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { requireHeadlessEngine, ServiceOwnerStore } from "../src/service-ownership.js";
import { nativeFixture } from "./native-fixture.js";

const fixtures: ReturnType<typeof nativeFixture>[] = [];
function fixture() {
  const f = nativeFixture();
  fixtures.push(f);
  return {
    ...f,
    owner: new ServiceOwnerStore({ stateDir: f.stateDir, uid: process.getuid!() }),
    file: join(f.stateDir, "service-owner.json"),
  };
}
afterEach(() => {
  for (const f of fixtures.splice(0)) f.close();
});
const desktop = {
  v: 1 as const,
  mode: "desktop" as const,
  consented: true,
  startupEnabled: false,
  transition: null,
};

it.each(["prepared", "source-stopped", "destination-started", "recovery-required"] as const)(
  "admits only the bound headless destination during %s",
  async (phase) => {
    const f = fixture();
    const id = "00000000-0000-4000-8000-000000000002";
    await f.owner.mutate(null, async (tx) => {
      tx.publish({
        ...desktop,
        mode: "headless",
        transition: {
          id,
          source: "desktop",
          target: "headless",
          sourceManager: "desktop-child",
          sourceInstance: f.selection.serviceInstance,
          stateDir: f.stateDir,
          computerFp: f.identity.fp,
          targetBundlePath: f.bundle,
          targetVersion: "1.0.0",
          phase,
        },
      });
    });
    const options = { stateDir: f.stateDir, uid: process.getuid!(), serviceInstance: id };
    if (phase === "source-stopped" || phase === "destination-started")
      expect(() => requireHeadlessEngine(options)).not.toThrow();
    else expect(() => requireHeadlessEngine(options)).toThrow();
    expect(() =>
      requireHeadlessEngine({ ...options, serviceInstance: f.selection.serviceInstance }),
    ).toThrow();
    expect(() => requireHeadlessEngine({ ...options, serviceInstance: null })).toThrow();
  },
);

it("inspects absent ownership without creating directories or records", () => {
  const f = fixture();
  const missing = join(f.dir, "not-created");
  expect(new ServiceOwnerStore({ stateDir: missing, uid: process.getuid!() }).inspect()).toBeNull();
  expect(existsSync(missing)).toBe(false);
  expect(f.owner.inspect()).toBeNull();
  expect(existsSync(f.file)).toBe(false);
});
it("publishes private revisioned ownership without changing agent identity", async () => {
  const f = fixture();
  const identity = readFileSync(f.p.identity);
  await f.owner.mutate(null, async (tx) => {
    tx.publish(desktop);
  });
  expect(f.owner.inspect()).toMatchObject(desktop);
  expect(f.owner.inspect()?.revision).toMatch(/^[a-f0-9-]{36}$/);
  expect(statSync(f.file).mode & 0o777).toBe(0o600);
  expect(readFileSync(f.p.identity)).toEqual(identity);
});
it("rejects stale revisions without replacing the current preference", async () => {
  const f = fixture();
  await f.owner.mutate(null, async (tx) => {
    tx.publish(desktop);
  });
  const before = readFileSync(f.file);
  await expect(
    f.owner.mutate(null, async (tx) => {
      tx.publish({ ...desktop, startupEnabled: true });
    }),
  ).rejects.toMatchObject({ code: "conflict" });
  expect(readFileSync(f.file)).toEqual(before);
});
it("holds exclusion throughout async work while unrelated hosts remain independent", async () => {
  const f = fixture(),
    other = fixture();
  let release!: () => void;
  let entered!: () => void;
  const entry = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const work = f.owner.mutate(null, async (tx) => {
    entered();
    await gate;
    tx.publish(desktop);
  });
  await entry;
  try {
    const competing = new ServiceOwnerStore({ stateDir: f.stateDir, uid: process.getuid!() });
    await expect(
      competing.mutate(null, async (tx) => {
        tx.publish(desktop);
      }),
    ).rejects.toMatchObject({ code: "busy" });
    await other.owner.mutate(null, async (tx) => {
      tx.publish({ ...desktop, mode: "headless" });
    });
  } finally {
    release();
    await work;
  }
  expect(f.owner.inspect()?.mode).toBe("desktop");
  expect(other.owner.inspect()?.mode).toBe("headless");
});
it.each([
  "bad-json",
  "unknown-mode",
  "unknown-field",
  "oversized",
  "public-file",
  "wrong-user",
  "symlink",
])("refuses unsafe ownership: %s", (kind) => {
  const f = fixture();
  const value = { ...desktop, revision: "00000000-0000-4000-8000-000000000001" };
  writeFileSync(
    f.file,
    kind === "bad-json"
      ? "{"
      : JSON.stringify(
          kind === "unknown-mode"
            ? { ...value, mode: "root" }
            : kind === "unknown-field"
              ? { ...value, extra: true }
              : value,
        ) + (kind === "oversized" ? " ".repeat(16384) : ""),
    { mode: 0o600 },
  );
  if (kind === "public-file") chmodSync(f.file, 0o644);
  let owner = f.owner;
  if (kind === "wrong-user")
    owner = new ServiceOwnerStore({ stateDir: f.stateDir, uid: process.getuid!() + 1 });
  if (kind === "symlink") {
    symlinkSync(f.stateDir, join(f.dir, "alias"));
    owner = new ServiceOwnerStore({ stateDir: join(f.dir, "alias"), uid: process.getuid!() });
  }
  expect(() => owner.inspect()).toThrow();
});
it("preserves published conversion intent when its operation fails", async () => {
  const f = fixture();
  const transition = {
    id: "00000000-0000-4000-8000-000000000002",
    source: "legacy-native" as const,
    target: "desktop" as const,
    sourceManager: "native-persistent" as const,
    sourceInstance: null,
    stateDir: f.stateDir,
    computerFp: f.identity.fp,
    targetBundlePath: f.bundle,
    targetVersion: "1.0.0",
    phase: "prepared" as const,
  };
  await expect(
    f.owner.mutate(null, async (tx) => {
      tx.publish({ ...desktop, transition });
      throw new Error("interrupted");
    }),
  ).rejects.toThrow();
  expect(f.owner.inspect()?.transition).toEqual(transition);
});
it("refuses use of a transaction after its guard is released", async () => {
  const f = fixture();
  let late!: () => void;
  await f.owner.mutate(null, async (tx) => {
    late = () => {
      tx.publish(desktop);
    };
  });
  expect(late).toThrow();
  expect(f.owner.inspect()).toBeNull();
});
