import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const addonPath =
  "Contents/Resources/agent/node_modules/@node-datachannel/darwin-arm64/node_datachannel.node";
export const addonVersion = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).dependencies["node-datachannel"];
export const candidatePath = "Contents/Resources/signed-candidate.json";
export const teamId = "TESTTEAM01";
export const metadata = {
  arch: "arm64",
  sourceCommit: "a".repeat(40),
  runtimeArchiveSha256: "fb526811860f81dcac7dd8b2b55eca4accfc5d61c3b7c2508f2639faee8a738d",
  developmentInventorySha256: "b".repeat(64),
  teamId,
};
export const nativeBytes = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 1, 2, 3, 4]);
export function signedApi(name: string) {
  return import(pathToFileURL(resolve(`../macos/scripts/${name}.mjs`)).href);
}
export function put(path: string, data: string | Buffer) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
}
export function signedFixture() {
  const root = mkdtempSync(join(tmpdir(), "sb-signed-test-"));
  const app = join(root, "Shellbell.app");
  const info = {
    CFBundleIdentifier: "sh.bilal.shellbell.host",
    CFBundleExecutable: "Shellbell",
    CFBundlePackageType: "APPL",
    CFBundleShortVersionString: "0.0.1",
    CFBundleVersion: "1",
    CFBundleIconFile: "ShellbellService",
    LSMinimumSystemVersion: "13.0",
    LSUIElement: true,
  };
  const launch = {
    Label: "sh.bilal.shellbell.host.agent",
    BundleProgram: "Contents/MacOS/Shellbell",
    ProgramArguments: ["Shellbell", "--service-run", "persistent"],
    RunAtLoad: true,
    KeepAlive: true,
    ProcessType: "Background",
    ThrottleInterval: 10,
  };
  const files: Record<string, string | Buffer> = {
    "Contents/Info.plist": JSON.stringify(info),
    "Contents/Library/LaunchAgents/sh.bilal.shellbell.host.agent.plist": JSON.stringify(launch),
    "Contents/MacOS/Shellbell": nativeBytes,
    "Contents/Library/HelperTools/ShellbellPowerHelper": nativeBytes,
    "Contents/Library/LaunchDaemons/sh.bilal.shellbell.power.plist": JSON.stringify({
      Label: "sh.bilal.shellbell.power",
      BundleProgram: "Contents/Library/HelperTools/ShellbellPowerHelper",
      ProgramArguments: ["ShellbellPowerHelper"],
      UserName: "root",
      MachServices: { "sh.bilal.shellbell.power": true },
      RunAtLoad: true,
      KeepAlive: true,
      ProcessType: "Background",
      ThrottleInterval: 10,
      ExitTimeOut: 20,
    }),
    "Contents/Helpers/node": nativeBytes,
    [addonPath]: nativeBytes,
    "Contents/Resources/agent/node_modules/node-datachannel/package.json": JSON.stringify({
      name: "node-datachannel",
      version: addonVersion,
    }),
    "Contents/Resources/agent/node_modules/@node-datachannel/darwin-arm64/package.json":
      JSON.stringify({ name: "@node-datachannel/darwin-arm64", version: addonVersion }),
    "Contents/Resources/runtime/LICENSE": "runtime license",
    "Contents/Resources/agent/package.json": JSON.stringify({
      name: "shellbell",
      version: "0.0.1",
      type: "module",
      dependencies: {},
    }),
    "Contents/Resources/licenses/Shellbell-LICENSE": "license",
    "Contents/Resources/licenses/index.json": JSON.stringify([
      { name: "shellbell", version: "0.0.1", files: ["Shellbell-LICENSE"] },
    ]),
  };
  for (const name of ["ShellbellService.icns", "ShellbellTemplate.png", "ShellbellTemplate@2x.png"])
    files[`Contents/Resources/${name}`] = "icon";
  for (const name of ["cli.js", "native-controller.js", "native-service.js"])
    files[`Contents/Resources/agent/dist/${name}`] = "export {};";
  for (const [name, data] of Object.entries(files)) put(join(app, name), data);
  chmodSync(join(app, "Contents/Helpers/node"), 0o755);
  chmodSync(join(app, "Contents/MacOS/Shellbell"), 0o755);
  chmodSync(join(app, "Contents/Library/HelperTools/ShellbellPowerHelper"), 0o755);
  const runtimeCalls: string[] = [];
  const run = async (file: string, args: string[]) => {
    if (file === "/usr/bin/plutil") return readFileSync(args.at(-1)!, "utf8");
    if (file === "/usr/bin/lipo") return "arm64";
    if (file.endsWith("/Helpers/node")) {
      runtimeCalls.push(args.join(" "));
      return "v22.23.1";
    }
    throw Error(`Unexpected fixture command: ${file}`);
  };
  return { root, app, runtimeCalls, run };
}
