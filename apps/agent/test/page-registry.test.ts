import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { WebPagesSchema } from "@shellbell/protocol";
import { afterEach, expect, it, vi } from "vitest";
import { hasForeignWriteACL, PageRegistry, validPagePNG } from "../src/web/page-registry.js";

const homes: string[] = [],
  registries: PageRegistry[] = [];
afterEach(() => {
  for (const r of registries.splice(0)) r.close();
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "shellbell-pages-"));
  homes.push(home);
  const folder = join(home, ".config/shellbell/apps");
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const registry = new PageRegistry({ home, platform: "linux" });
  registries.push(registry);
  const put = (id: string, value: unknown, mode = 0o644) => {
    const file = join(folder, `${id}.json`);
    writeFileSync(file, JSON.stringify(value), { mode });
    chmodSync(file, mode);
    return file;
  };
  return { home, folder, registry, put };
}
function png(width = 1, height = width, ancillary = 0): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const b = Buffer.alloc(data.length + 12);
    b.writeUInt32BE(data.length);
    b.write(type, 4);
    data.copy(b, 8);
    b.writeUInt32BE(crc32(b.subarray(4, b.length - 4)), b.length - 4);
    return b;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    ...(ancillary ? [chunk("tEXt", Buffer.alloc(ancillary, 65))] : []),
    chunk("IDAT", deflateSync(Buffer.from([0, 0, 0, 0, 255]))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
it("does not rewrite protected directory metadata during unchanged scans", async () => {
  const f = fixture();
  await f.registry.refresh();
  const paths = [join(f.home, ".config/shellbell"), f.folder];
  const before = paths.map((p) => statSync(p, { bigint: true }).ctimeNs);
  await f.registry.refresh();
  await f.registry.refresh();
  expect(paths.map((p) => statSync(p, { bigint: true }).ctimeNs)).toEqual(before);
});
it("reuses unchanged ACL checks but revalidates security metadata changes", async () => {
  const f = fixture();
  const file = f.put("board", { shellbell: 1, name: "Board", url: "http://localhost:3000" });
  let foreign = false;
  const acl = vi.fn(async (p: string) =>
    foreign && p === realpathSync(file) ? " 0: group:everyone allow write,delete" : "",
  );
  const registry = new PageRegistry({ home: f.home, platform: "darwin", acl });
  registries.push(registry);
  await registry.refresh();
  const calls = acl.mock.calls.length;
  await registry.refresh();
  await registry.refreshIfChanged();
  expect(acl.mock.calls).toHaveLength(calls);
  foreign = true;
  // Like an ACL edit, even an unchanged chmod changes ctime without changing
  // the file's contents, mtime or ordinary permission bits.
  chmodSync(file, 0o644);
  await registry.refreshIfChanged();
  expect(registry.get("board")).toBeUndefined();
  expect(registry.entries[0]?.skipped?.reason).toMatch(/write access/);
});
it("discovers versioned registrations with ordinary 0644 files, ignoring extra fields", async () => {
  const f = fixture();
  f.put("board", {
    shellbell: 1,
    name: "Board",
    start: [process.execPath, "serve"],
    unused: "future",
  });
  f.put("metrics", { shellbell: 1, name: "Metrics", url: "http://127.0.0.1:3000/dashboard" });
  await f.registry.refresh();
  expect(f.registry.entries.map((p) => p.name)).toEqual(["Board", "Metrics"]);
  expect(f.registry.get("board")?.start).toEqual([process.execPath, "serve"]);
  expect(f.registry.get("metrics")?.url?.path).toBe("/dashboard");
  expect(f.registry.entries[1]?.address).toBe("127.0.0.1:3000");
  expect(WebPagesSchema.safeParse(f.registry.entries).success).toBe(true);
});
it("refuses a group-writable config parent with a usable fix, without changing its permissions", async () => {
  const f = fixture(),
    parent = join(f.home, ".config");
  chmodSync(parent, 0o775);
  f.put("board", { shellbell: 1, name: "Board", start: [process.execPath] });
  await f.registry.refresh();
  expect(f.registry.entries[0]?.skipped?.fix).toBe("chmod g-w ~/.config");
  expect(statSync(parent).mode & 0o777).toBe(0o775);
  expect(f.registry.get("board")).toBeUndefined();
});
it("refuses group-writable registrations even when their group belongs to the owner", async () => {
  const f = fixture();
  f.put("board", { shellbell: 1, name: "Board", start: [process.execPath] }, 0o664);
  await f.registry.refresh();
  expect(f.registry.entries[0]?.skipped?.reason).toMatch(/not be writable/);
  expect(f.registry.get("board")).toBeUndefined();
});
it("does not follow registration-file symlinks or accept writable working directories", async () => {
  const f = fixture(),
    source = join(f.home, "source.json"),
    cwd = join(f.home, "workspace");
  writeFileSync(
    source,
    JSON.stringify({ shellbell: 1, name: "Linked", start: [process.execPath] }),
    { mode: 0o600 },
  );
  symlinkSync(source, join(f.folder, "linked.json"));
  mkdirSync(cwd, { mode: 0o777 });
  chmodSync(cwd, 0o777);
  f.put("workspace", { shellbell: 1, name: "Workspace", start: [process.execPath], cwd });
  await f.registry.refresh();
  expect(f.registry.entries.every((row) => row.skipped)).toBe(true);
  expect(f.registry.get("linked")).toBeUndefined();
});
it("resolves a symlinked .config through its protected physical parents", async () => {
  const f = fixture();
  rmSync(join(f.home, ".config"), { recursive: true });
  const target = join(f.home, "dotfiles");
  mkdirSync(target, { mode: 0o700 });
  symlinkSync(target, join(f.home, ".config"));
  await f.registry.refresh();
  f.put("board", { shellbell: 1, name: "Board", url: "http://localhost:8080/" });
  await f.registry.refresh();
  expect(f.registry.get("board")?.url?.origin.authority).toBe("localhost:8080");
});
it("keeps stopped URL servers listed but hides missing executable registrations", async () => {
  const f = fixture();
  f.put("gone", { shellbell: 1, name: "Gone", start: [join(f.home, "missing")] });
  f.put("local", { shellbell: 1, name: "Local", url: "http://127.0.0.1:1/" });
  await f.registry.refresh();
  expect(f.registry.entries.map((r) => r.id)).toEqual(["local"]);
});
it("rejects non-local addresses, mixed targets, unsupported versions and oversized files", async () => {
  const f = fixture();
  f.put("remote", { shellbell: 1, name: "Remote", url: "http://192.168.1.2/" });
  f.put("mixed", {
    shellbell: 1,
    name: "Mixed",
    start: [process.execPath],
    url: "http://localhost/",
  });
  f.put("newer", { shellbell: 2, name: "Future", url: "http://localhost/" });
  f.put("large", {
    shellbell: 1,
    name: "Large",
    url: "http://localhost/",
    ignored: "x".repeat(17000),
  });
  await f.registry.refresh();
  expect(f.registry.entries.every((r) => r.skipped)).toBe(true);
});
it("validates bounded square PNGs and updates hashes without retiring the registration", async () => {
  const f = fixture(),
    icon = join(f.home, "icon.png");
  writeFileSync(icon, png(), { mode: 0o644 });
  f.put("board", { shellbell: 1, name: "Board", url: "http://localhost:8000/", icon });
  await f.registry.refresh();
  const first = f.registry.get("board")!;
  expect(first.icon?.hash).toMatch(/^[a-f0-9]{64}$/);
  writeFileSync(icon, png(1, 1, 20000));
  await f.registry.refresh();
  expect(f.registry.get("board")?.revision).toBe(first.revision);
  expect(f.registry.get("board")?.icon?.hash).not.toBe(first.icon?.hash);
  for (const bytes of [Buffer.from("<svg/>"), png(2, 1), png(1025), png(1, 1, 65536)]) {
    writeFileSync(icon, bytes);
    await f.registry.refresh();
    expect(f.registry.get("board")).toBeDefined();
    expect(f.registry.entries[0]?.icon).toBeUndefined();
    expect(f.registry.entries[0]?.iconIssue).toBeDefined();
  }
  writeFileSync(icon, png());
  chmodSync(icon, 0o664);
  await f.registry.refresh();
  expect(f.registry.entries[0]?.iconIssue?.reason).toMatch(/not be writable/);
  expect(f.registry.entries[0]?.skipped).toBeUndefined();
});
it("rejects damaged PNG checksums and trailers", () => {
  const good = png(),
    bad = Buffer.from(good);
  bad[bad.length - 1] = bad[bad.length - 1]! ^ 1;
  expect(validPagePNG(good)).toBe(true);
  expect(validPagePNG(bad)).toBe(false);
  expect(validPagePNG(Buffer.concat([good, Buffer.from("trailer")]))).toBe(false);
});
it("checks existing ACL grants, including write security and inherited foreign grants", () => {
  expect(hasForeignWriteACL(" 0: group:staff allow read,write", 501, "owner")).toBe(true);
  expect(hasForeignWriteACL(" 0: user:502 inherited allow delete,writeattr", 501, "owner")).toBe(
    true,
  );
  expect(hasForeignWriteACL(" 0: user:owner allow read,write", 501, "owner")).toBe(false);
  expect(hasForeignWriteACL(" 0: user:501 allow writesecurity", 501, "owner")).toBe(false);
  expect(hasForeignWriteACL(" 0: group:everyone deny delete", 501, "owner")).toBe(false);
});
it("watches registration edits and keeps the advertised catalog bounded", async () => {
  const f = fixture();
  await f.registry.start();
  f.put("board", { shellbell: 1, name: "Board", url: "http://localhost:3000/" });
  await vi.waitFor(() => expect(f.registry.get("board")).toBeDefined());
  for (let n = 0; n < 20; n++)
    f.put(`page-${n}`, { shellbell: 1, name: `Page ${n}`, url: "http://localhost:3000/" });
  await f.registry.refresh();
  expect(f.registry.entries).toHaveLength(16);
  expect(f.registry.issues).toHaveLength(1);
});
