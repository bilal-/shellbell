import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { signedApi } from "./native-signed-fixture.js";

type RecordValue = Record<string, unknown>;
type Call = { file: string; args: string[]; options: RecordValue };
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const validInfo = () => ({
  Format: "UDZO",
  Properties: { Checksummed: true, Compressed: true, Encrypted: false },
  "Size Information": { "Total Bytes": 1024 * 1024 },
});
function fixture(
  options: {
    info?: unknown;
    entities?: (mount: string) => unknown;
    attachFailure?: boolean;
    detachFailure?: boolean;
    verifyFailure?: boolean;
    malformedPlist?: boolean;
    oversizedPlist?: boolean;
    conversionFailure?: boolean;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "sb-dmg-mount-test-"));
  roots.push(root);
  const image = join(root, "fixture.dmg");
  writeFileSync(image, "owned image fixture");
  const calls: Call[] = [];
  let mount = "";
  let scratch = "";
  let detached = false;
  const run = async (file: string, args: string[], commandOptions: RecordValue = {}) => {
    calls.push({ file, args, options: commandOptions });
    if (file === "/usr/bin/plutil") {
      const input = args.at(-1)!;
      scratch = dirname(input);
      if (!roots.includes(scratch)) roots.push(scratch);
      if (options.conversionFailure) throw Error("conversion rejected");
      return { stdout: readFileSync(input, "utf8"), stderr: "" };
    }
    if (file !== "/usr/bin/hdiutil") throw Error("unexpected command");
    if (args[0] === "imageinfo") {
      const info = Object.hasOwn(options, "info") ? options.info : validInfo();
      return {
        stdout: options.malformedPlist
          ? "not a plist"
          : options.oversizedPlist
            ? "x".repeat(65537)
            : JSON.stringify(info),
        stderr: "",
      };
    }
    if (args[0] === "verify") {
      if (options.verifyFailure) throw Error("image checksum failed");
      return { stdout: "", stderr: "" };
    }
    if (args[0] === "attach") {
      mount = args[args.indexOf("-mountpoint") + 1]!;
      scratch = dirname(mount);
      if (!roots.includes(scratch)) roots.push(scratch);
      writeFileSync(join(mount, "sentinel"), "fixture");
      if (options.attachFailure) throw Error("attach failed after mount");
      const entities = options.entities?.(mount) ?? [
        {
          "mount-point": mount,
          "volume-kind": "hfs",
          "content-hint": "Apple_HFS",
          "potentially-mountable": true,
        },
        { "content-hint": "GUID_partition_scheme", "potentially-mountable": false },
      ];
      return { stdout: JSON.stringify({ "system-entities": entities }), stderr: "" };
    }
    if (args[0] === "detach") {
      if (options.detachFailure) throw Error("volume busy");
      expect(args).toEqual(["detach", mount]);
      detached = true;
      return { stdout: "", stderr: "" };
    }
    throw Error("unexpected hdiutil operation");
  };
  return {
    image,
    run,
    calls,
    mount: () => mount,
    scratch: () => scratch,
    detached: () => detached,
  };
}

it("inspects only an owned canonical read-only mount and returns after detach", async () => {
  const f = fixture();
  const { withReadonlyDmg } = await signedApi("dmg-mount");
  const result = await withReadonlyDmg(
    f.image,
    async (mount: string) => {
      expect(mount).toBe(realpathSync(mount));
      expect(statSync(dirname(mount)).mode & 0o777).toBe(0o700);
      expect(f.detached()).toBe(false);
      return readFileSync(join(mount, "sentinel"), "utf8");
    },
    { run: f.run },
  );
  expect(result).toBe("fixture");
  expect(f.detached()).toBe(true);
  expect(existsSync(f.scratch())).toBe(false);
  const operations = f.calls.filter((call) => call.file === "/usr/bin/hdiutil");
  expect(operations.map((call) => call.args[0])).toEqual([
    "imageinfo",
    "verify",
    "attach",
    "detach",
  ]);
  expect(operations[2]!.args).toEqual([
    "attach",
    "-readonly",
    "-nobrowse",
    "-noautoopen",
    "-noautofsck",
    "-mountpoint",
    f.mount(),
    "-plist",
    f.image,
  ]);
  for (const call of f.calls) {
    expect(call.options.timeout).toBeGreaterThan(0);
    expect(call.options.timeout).toBeLessThanOrEqual(60000);
    expect(call.options.maxBuffer).toBeLessThanOrEqual(65536);
  }
  expect(readFileSync(f.image, "utf8")).toBe("owned image fixture");
});

it.each([
  ["null", null],
  ["array", []],
  ["wrong format", { ...validInfo(), Format: "UDRW" }],
  [
    "encrypted",
    { ...validInfo(), Properties: { Checksummed: true, Compressed: true, Encrypted: true } },
  ],
  [
    "unchecked",
    { ...validInfo(), Properties: { Checksummed: false, Compressed: true, Encrypted: false } },
  ],
  [
    "uncompressed",
    { ...validInfo(), Properties: { Checksummed: true, Compressed: false, Encrypted: false } },
  ],
  ["missing properties", { Format: "UDZO", "Size Information": { "Total Bytes": 1024 } }],
  ["missing size", { ...validInfo(), "Size Information": {} }],
  ["zero size", { ...validInfo(), "Size Information": { "Total Bytes": 0 } }],
  ["negative size", { ...validInfo(), "Size Information": { "Total Bytes": -1 } }],
  ["fractional size", { ...validInfo(), "Size Information": { "Total Bytes": 1.5 } }],
  ["string size", { ...validInfo(), "Size Information": { "Total Bytes": "1024" } }],
  ["oversized", { ...validInfo(), "Size Information": { "Total Bytes": 2 * 1024 ** 3 + 1 } }],
])("rejects %s image metadata before attach", async (_name, info) => {
  const f = fixture({ info });
  const { withReadonlyDmg } = await signedApi("dmg-mount");
  let inspected = false;
  await expect(
    withReadonlyDmg(
      f.image,
      () => {
        inspected = true;
      },
      { run: f.run },
    ),
  ).rejects.toMatchObject({ code: "dmg-format" });
  expect(inspected).toBe(false);
  expect(f.calls.some((call) => call.args[0] === "attach")).toBe(false);
  expect(existsSync(f.scratch())).toBe(false);
});

it.each(["malformedPlist", "oversizedPlist", "conversionFailure", "verifyFailure"] as const)(
  "fails closed on %s before mounting",
  async (failure) => {
    const f = fixture({ [failure]: true });
    const { withReadonlyDmg } = await signedApi("dmg-mount");
    let inspected = false;
    await expect(
      withReadonlyDmg(
        f.image,
        () => {
          inspected = true;
        },
        { run: f.run },
      ),
    ).rejects.toThrow();
    expect(inspected).toBe(false);
    expect(f.calls.some((call) => call.args[0] === "attach")).toBe(false);
    if (f.scratch()) expect(existsSync(f.scratch())).toBe(false);
  },
);

it.each(["missing", "not-array", "wrong-path", "duplicate", "non-hfs", "unmounted-extra"] as const)(
  "detaches and refuses %s attach output before inspecting",
  async (failure) => {
    const f = fixture({
      entities: (mount) => {
        const entity = {
          "mount-point": mount,
          "volume-kind": "hfs",
          "content-hint": "Apple_HFS",
          "potentially-mountable": true,
        };
        switch (failure) {
          case "missing":
            return [];
          case "not-array":
            return {};
          case "wrong-path":
            return [{ ...entity, "mount-point": "/Volumes/not-ours" }];
          case "duplicate":
            return [entity, entity];
          case "non-hfs":
            return [{ ...entity, "volume-kind": "apfs" }];
          case "unmounted-extra":
            return [entity, { "potentially-mountable": true }];
        }
      },
    });
    const { withReadonlyDmg } = await signedApi("dmg-mount");
    let inspected = false;
    await expect(
      withReadonlyDmg(
        f.image,
        () => {
          inspected = true;
        },
        { run: f.run },
      ),
    ).rejects.toMatchObject({ code: "dmg-mount-layout" });
    expect(inspected).toBe(false);
    expect(f.detached()).toBe(true);
    expect(existsSync(f.scratch())).toBe(false);
  },
);

it("attempts detach even when attach rejects after creating a mount", async () => {
  const f = fixture({ attachFailure: true });
  const { withReadonlyDmg } = await signedApi("dmg-mount");
  let inspected = false;
  await expect(
    withReadonlyDmg(
      f.image,
      () => {
        inspected = true;
      },
      { run: f.run },
    ),
  ).rejects.toThrow("attach failed after mount");
  expect(inspected).toBe(false);
  expect(f.detached()).toBe(true);
  expect(existsSync(f.scratch())).toBe(false);
});

it("detaches after an asynchronous payload inspection failure", async () => {
  const f = fixture();
  const { withReadonlyDmg } = await signedApi("dmg-mount");
  await expect(
    withReadonlyDmg(
      f.image,
      async () => {
        throw Error("bad payload");
      },
      { run: f.run },
    ),
  ).rejects.toThrow("bad payload");
  expect(f.detached()).toBe(true);
  expect(existsSync(f.scratch())).toBe(false);
});

it.each([false, true])(
  "preserves scratch and fails on detach failure (callback fails: %s)",
  async (fail) => {
    const f = fixture({ detachFailure: true });
    const { withReadonlyDmg } = await signedApi("dmg-mount");
    const result = withReadonlyDmg(
      f.image,
      async () => {
        if (fail) throw Error("bad payload");
        return "must not return success";
      },
      { run: f.run },
    );
    await expect(result).rejects.toMatchObject({
      code: "dmg-detach",
      mountPoint: expect.any(String),
      scratch: expect.any(String),
    });
    expect(existsSync(f.scratch())).toBe(true);
    expect(readFileSync(join(f.mount(), "sentinel"), "utf8")).toBe("fixture");
    expect(f.calls.at(-1)!.args).toEqual(["detach", f.mount()]);
  },
);
