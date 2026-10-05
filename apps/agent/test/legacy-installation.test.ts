import { describe, expect, it } from "vitest";
import { createLaunchdManager } from "../src/launchd.js";
import { createNativePlatform } from "../src/native/platform.js";
import type { ServiceCommand } from "../src/service-command.js";

async function check(run: ServiceCommand) {
  const module = await import("../src/legacy-installation.js").catch(() => null);
  expect(module?.assertNoLegacyRegistration).toBeTypeOf("function");
  await module!.assertNoLegacyRegistration(run, 501);
}
describe("legacy registration admission", () => {
  it("allows absent jobs without issuing mutation commands", async () => {
    const targets: string[] = [];
    await check(async (exe, args) => {
      expect(exe).toBe("/bin/launchctl");
      expect(args[0]).toBe("print");
      targets.push(args[1]!);
      return { exitCode: 113, stdout: Buffer.alloc(0) };
    });
    expect(targets).toEqual([
      "gui/501/dev.bilalahmad.shellbell",
      "gui/501/dev.bilalahmad.shellbell.host.agent",
      "gui/501/dev.bilalahmad.shellbell.host.manual",
      "system/dev.bilalahmad.shellbell.power",
    ]);
  });
  it.each([
    "dev.bilalahmad.shellbell",
    "dev.bilalahmad.shellbell.host.agent",
    "dev.bilalahmad.shellbell.host.manual",
    "dev.bilalahmad.shellbell.power",
  ])("rejects an existing %s registration", async (label) => {
    await expect(
      check(async (_exe, args) => ({
        exitCode: args[1]!.endsWith(`/${label}`) ? 0 : 113,
        stdout: Buffer.alloc(0),
      })),
    ).rejects.toThrow(/legacy.*migration/i);
  });
  it("fails closed when launchctl cannot establish absence", async () => {
    await expect(check(async () => ({ exitCode: 5, stdout: Buffer.alloc(0) }))).rejects.toThrow(
      /verify/i,
    );
  });
  it("blocks headless load before touching an old installation", async () => {
    const manager = createLaunchdManager({
      homeDir: "/tmp/shellbell-legacy-fixture",
      uid: 501,
      run: async () => ({ exitCode: 0, stdout: Buffer.alloc(0) }),
    });
    await expect(manager.load()).rejects.toThrow(/legacy.*migration/i);
  });
  it("blocks desktop preflight before touching an old installation", async () => {
    const platform = createNativePlatform({
      root: "/tmp/shellbell-legacy-fixture/native",
      homeDir: "/tmp/shellbell-legacy-fixture",
      uid: 501,
      run: async () => ({ exitCode: 0, stdout: Buffer.alloc(0) }),
    });
    await expect(platform.preflight("manual", "/tmp/Shellbell.app")).rejects.toThrow(
      /legacy.*migration/i,
    );
  });
});
