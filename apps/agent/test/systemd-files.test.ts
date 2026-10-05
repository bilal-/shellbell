import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { lifecycleFixture } from "./systemd-fixtures.js";

vi.mock("node:child_process", () => ({
  spawn: () => {
    throw new Error("unexpected spawn");
  },
  execFile: () => {
    throw new Error("unexpected execFile");
  },
}));
vi.mock("../src/identity.js", () => ({
  readIdentity: () => {
    throw new Error("legacy identity read");
  },
  loadOrCreateIdentity: () => {
    throw new Error("identity creation");
  },
}));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, writeFileSync: vi.fn(fs.writeFileSync), symlinkSync: vi.fn(fs.symlinkSync) };
});

async function fixture() {
  const f = await lifecycleFixture();
  const api = (await import("../src/systemd-files.js").catch(
    () => ({}),
  )) as typeof import("../src/systemd-files.js");
  expect(api.SystemdFiles, "owned filesystem transactions must exist").toBeTypeOf("function");
  return { ...f, files: new api.SystemdFiles(f.location, f.machine.machineId) };
}

describe("owned systemd files", () => {
  it("observes absent files without creating directories, then publishes private exclusive files", async () => {
    const f = await fixture();
    expect(f.files.inspect().unit).toBeNull();
    expect(existsSync(f.location.configRoot)).toBe(false);
    const before = f.files.inspect();
    const after = f.files.publish(before, f.definition);
    expect(lstatSync(f.location.definitionPath).mode & 0o777).toBe(0o600);
    expect(after.unit?.definition).toEqual(f.definition);
    expect(after.link).toBeNull();
  });
  it("refuses foreign bytes, unsafe modes, host mismatch and symlink leaves", async () => {
    const f = await fixture();
    f.files.publish(f.files.inspect(), f.definition);
    const original = readFileSync(f.location.definitionPath);
    writeFileSync(f.location.definitionPath, "FOREIGN_SENTINEL");
    expect(() => f.files.inspect()).toThrow(/foreign|unsafe/);
    writeFileSync(f.location.definitionPath, original);
    chmodSync(f.location.definitionPath, 0o644);
    expect(() => f.files.inspect()).toThrow();
    chmodSync(f.location.definitionPath, 0o600);
    expect(() =>
      f.files.publish(f.files.inspect(), { ...f.definition, machineId: "f".repeat(32) }),
    ).toThrow();
    renameSync(f.location.definitionPath, `${f.location.definitionPath}.saved`);
    symlinkSync(`${f.location.definitionPath}.saved`, f.location.definitionPath);
    expect(() => f.files.inspect()).toThrow();
  });
  it("detects concurrent replacements before publication or rollback and saves recovery evidence", async () => {
    const f = await fixture();
    const before = f.files.inspect();
    const published = f.files.publish(before, f.definition);
    renameSync(f.location.definitionPath, `${f.location.definitionPath}.saved`);
    writeFileSync(f.location.definitionPath, "FOREIGN_SENTINEL", { mode: 0o600 });
    expect(() => f.files.publish(published, f.definition)).toThrow();
    expect(() => f.files.restore(before, published)).toThrow(/recovery/);
    expect(readFileSync(f.location.definitionPath, "utf8")).toBe("FOREIGN_SENTINEL");
  });
  it("owns only its exact enablement link and refuses replaced or foreign links", async () => {
    const f = await fixture();
    const installed = f.files.publish(f.files.inspect(), f.definition);
    const enabled = f.files.setEnabled(installed, true);
    expect(readlinkSync(f.location.enablementPath)).toBe(f.location.definitionPath);
    const other = join(dirname(f.location.enablementPath), "other.service");
    symlinkSync("/external", other);
    f.files.setEnabled(enabled, false);
    expect(readlinkSync(other)).toBe("/external");
    symlinkSync("/foreign", f.location.enablementPath);
    expect(() => f.files.setEnabled(f.files.inspect(), false)).toThrow();
    expect(readlinkSync(f.location.enablementPath)).toBe("/foreign");
  });
  it("refuses symlinked app-owned directories without modifying their targets", async () => {
    const f = await fixture();
    mkdirSync(f.location.configRoot);
    const elsewhere = join(f.root, "elsewhere");
    mkdirSync(elsewhere, { mode: 0o700 });
    symlinkSync(elsewhere, join(f.location.configRoot, "systemd"));
    expect(() => f.files.publish({ unit: null, link: null }, f.definition)).toThrow();
    expect(existsSync(join(elsewhere, "user"))).toBe(false);
  });
  it("leaves the old definition intact after a staging write failure", async () => {
    const f = await fixture();
    const before = f.files.publish(f.files.inspect(), f.definition);
    const original = readFileSync(f.location.definitionPath);
    vi.mocked(writeFileSync).mockImplementationOnce(() => {
      throw new Error("WRITE_SENTINEL");
    });
    expect(() => f.files.publish(before, { ...f.definition, nodePath: "/new/node" })).toThrow();
    expect(readFileSync(f.location.definitionPath)).toEqual(original);
  });
  it("does not overwrite a replacement introduced while staging the definition", async () => {
    const f = await fixture();
    const before = f.files.publish(f.files.inspect(), f.definition);
    const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.mocked(writeFileSync).mockImplementationOnce((...args) => {
      renameSync(f.location.definitionPath, `${f.location.definitionPath}.previous`);
      fs.writeFileSync(f.location.definitionPath, "CONCURRENT_SENTINEL", { mode: 0o600 });
      fs.writeFileSync(...args);
    });
    expect(() => f.files.publish(before, { ...f.definition, nodePath: "/new/node" })).toThrow();
    expect(readFileSync(f.location.definitionPath, "utf8")).toBe("CONCURRENT_SENTINEL");
  });
  it("preserves files when exclusive enablement publication fails", async () => {
    const f = await fixture();
    const before = f.files.publish(f.files.inspect(), f.definition);
    vi.mocked(symlinkSync).mockImplementationOnce(() => {
      throw new Error("LINK_SENTINEL");
    });
    expect(() => f.files.setEnabled(before, true)).toThrow();
    expect(readFileSync(f.location.definitionPath)).toEqual(before.unit!.raw);
    expect(existsSync(f.location.enablementPath)).toBe(false);
  });
  it("keeps distinct host units independent in a shared home and rejects another user", async () => {
    const f = await fixture();
    f.files.publish(f.files.inspect(), f.definition);
    const { SystemdFiles } = await import("../src/systemd-files.js");
    const { readLinuxMachineIdentity } = await import("../src/host-machine.js");
    const { selectSystemdLocation } = await import("../src/systemd-unit.js");
    writeFileSync(f.machineOptions.machineIdPath, "f".repeat(32));
    const identity = readLinuxMachineIdentity(f.machineOptions);
    const location = selectSystemdLocation({ identity, env: f.env, home: f.home });
    const other = new SystemdFiles(location, identity.machineId);
    other.publish(other.inspect(), { ...f.definition, machineId: identity.machineId });
    expect(location.definitionPath).not.toBe(f.location.definitionPath);
    other.remove(other.inspect());
    expect(f.files.inspect().unit?.definition.machineId).toBe(f.machine.machineId);
    expect(() =>
      new SystemdFiles({ ...f.location, uid: f.location.uid + 1 }, f.machine.machineId).inspect(),
    ).toThrow();
  });
  it("matches canonical selected-root aliases but never a symlink unit leaf", async () => {
    const f = await fixture();
    f.files.publish(f.files.inspect(), f.definition);
    const alias = join(f.root, "config-alias");
    symlinkSync(f.location.configRoot, alias);
    expect(f.files.matchesFragment(join(alias, "systemd", "user", f.location.unitName))).toBe(true);
    const aliasLeaf = join(f.location.unitDir, "alias.service");
    symlinkSync(f.location.definitionPath, aliasLeaf);
    expect(f.files.matchesFragment(aliasLeaf)).toBe(false);
  });
});
