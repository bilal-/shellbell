import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, open, readFile, readlink, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { promisify } from "node:util";
import type { Command } from "commander";
import { type ReleaseAsset, ReleaseClient } from "./update-release.js";

const run = promisify(execFile);

/** The installer's report, plus the staging folder it keeps in HOME for the owner to remove. */
export function installerReport(result: { stdout: string; stderr: string }): string {
  const staging = result.stderr
    .split("\n")
    .filter((line) => line.startsWith("Shellbell staging directory: "));
  return [result.stdout.trim(), ...staging].filter(Boolean).join("\n");
}
export type UpdateInstallation = "linux-archive" | "mac-cli" | "mac-app" | "other";

export function requireUpdateMacOS(output: string, minimum: string): void {
  const pattern = /^\d{1,3}\.\d{1,3}(?:\.\d{1,3})?$/;
  if (!pattern.test(output.trim()) || !pattern.test(minimum))
    throw new Error("Could not verify the release's macOS requirement");
  const installed = output.trim().split(".").map(Number);
  const required = minimum.split(".").map(Number);
  const difference =
    [0, 1, 2].map((i) => (installed[i] ?? 0) - (required[i] ?? 0)).find((part) => part !== 0) ?? 0;
  if (difference < 0) throw new Error(`This release requires macOS ${minimum} or later`);
}

export function requireUpdateGlibc(output: string, minimum: string): void {
  const installed = /^glibc ([0-9]{1,6})\.([0-9]{1,6})\s*$/.exec(output);
  const required = /^([0-9]{1,6})\.([0-9]{1,6})$/.exec(minimum);
  if (!installed || !required)
    throw new Error(
      "Could not verify this release's glibc requirement; use the official manual installation guide",
    );
  const major = BigInt(installed[1]!);
  const minor = BigInt(installed[2]!);
  const requiredMajor = BigInt(required[1]!);
  const requiredMinor = BigInt(required[2]!);
  if (major < requiredMajor || (major === requiredMajor && minor < requiredMinor))
    throw new Error(
      `This release requires glibc ${minimum} or later; the installed system has ${installed[1]}.${installed[2]}`,
    );
}

export async function updateInstallation(options: {
  home: string;
  platform: string;
  arch: string;
  version: string;
  cli: string;
  node: string;
}): Promise<UpdateInstallation> {
  const cli = await realpath(options.cli);
  if (options.platform === "darwin" && options.arch === "arm64") {
    const root = join(
      await realpath(options.home),
      ".local/share/shellbell/installs/darwin-arm64",
      options.version,
    );
    if (
      cli === join(root, "Shellbell.app/Contents/Resources/agent/dist/cli.js") &&
      (await realpath(options.node)) === join(root, "Shellbell.app/Contents/Helpers/node")
    ) {
      const path = join(root, "installation.json");
      const stat = await lstat(path);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.nlink !== 1 ||
        stat.uid !== process.getuid!() ||
        stat.mode & 0o7022 ||
        stat.size > 4096
      )
        throw new Error("Unsafe managed CLI installation receipt");
      const receipt = JSON.parse(await readFile(path, "utf8"));
      if (
        receipt.schema !== 1 ||
        receipt.platform !== "darwin-arm64" ||
        receipt.version !== options.version ||
        !/^[a-f0-9]{64}$/.test(receipt.dmgSha256)
      )
        throw new Error("Invalid managed CLI installation receipt");
      return "mac-cli";
    }
  }
  if (
    options.platform === "darwin" &&
    cli.includes("/Shellbell.app/Contents/Resources/agent/dist/")
  )
    return "mac-app";
  if (options.platform !== "linux" || !["arm64", "x64"].includes(options.arch)) return "other";
  const root = join(
    await realpath(options.home),
    ".local/share/shellbell/installs",
    `linux-${options.arch}`,
    options.version,
  );
  if (
    cli !== join(root, "agent/dist/cli.js") ||
    (await realpath(options.node)) !== join(root, "runtime/bin/node")
  )
    return "other";
  return "linux-archive";
}

/** Stream the explicitly requested archive into a private, exclusively created file. */
export async function downloadUpdate(
  client: ReleaseClient,
  asset: ReleaseAsset,
  destination: string,
): Promise<void> {
  const response = await client.response(asset.browser_download_url, AbortSignal.timeout(180_000));
  if (!response.body) throw new Error("Empty update download");
  const reader = response.body.getReader();
  let file: Awaited<ReturnType<typeof open>> | undefined;
  let size = 0;
  const hash = createHash("sha256");
  try {
    file = await open(destination, "wx", 0o600);
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > asset.size) throw new Error("Update download exceeds the published size");
      hash.update(value);
      let offset = 0;
      while (offset < value.byteLength) {
        const { bytesWritten } = await file.write(value, offset, value.byteLength - offset);
        if (!bytesWritten) throw new Error("Could not write update download");
        offset += bytesWritten;
      }
    }
    if (size !== asset.size || `sha256:${hash.digest("hex")}` !== asset.digest)
      throw new Error("Update download does not match the published digest");
  } finally {
    try {
      await reader.cancel();
    } finally {
      await file?.close();
    }
  }
}

async function confirm(version: string): Promise<boolean> {
  if (!process.stdin.isTTY)
    throw new Error(
      "Use --yes to install an update without an interactive terminal, or --check to check only",
    );
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test(
      (
        await prompt.question(
          `Download and install Shellbell ${version}? The running service will stay on its current version. [y/N] `,
        )
      ).trim(),
    );
  } finally {
    prompt.close();
  }
}

export function addUpdateCommand(program: Command, currentVersion: string): void {
  program
    .command("update [version]")
    .description("check computer updates; manually update managed macOS/Linux CLI installs")
    .option("--check", "check only; do not download or install an app/archive")
    .option("--yes", "confirm installation without prompting")
    .action(
      async (requestedVersion: string | undefined, options: { check?: boolean; yes?: boolean }) => {
        const json = Boolean(program.opts().json);
        if (json && !options.check)
          throw new Error("Use --check with --json; installation requires human-readable output");
        const client = new ReleaseClient();
        const { check, assets } = await client.check(currentVersion, requestedVersion);
        if (json) {
          console.log(JSON.stringify(check));
          return;
        }
        console.log(
          `Installed: ${currentVersion}. Latest stable computer release: ${check.release.version}.`,
        );
        console.log(`Release notes: ${check.releaseUrl}`);
        if (!check.available) {
          console.log("No newer computer version is available.");
          return;
        }
        if (options.check) return;
        const home = await realpath(homedir());
        const installation = await updateInstallation({
          home,
          platform: process.platform,
          arch: process.arch,
          version: currentVersion,
          cli: process.argv[1]!,
          node: process.execPath,
        });
        if (installation === "mac-app") {
          console.log(
            "Open Shellbell → Settings → General → Check for Updates to download the official Mac installer.",
          );
          return;
        }
        if (installation !== "linux-archive" && installation !== "mac-cli") {
          console.log(
            "This installation is managed outside the CLI installer. Use its original installation method.",
          );
          if (process.platform === "darwin")
            console.log(
              `For a global npm installation, stop Shellbell first, then run: npm install -g shellbell@${check.release.version}`,
            );
          console.log("No files or services were changed.");
          console.log(
            "Installation guide: https://github.com/bilal-/shellbell/blob/main/docs/install-agent.md",
          );
          return;
        }
        const asset =
          installation === "mac-cli"
            ? assets.macosArm64
            : process.arch === "arm64"
              ? assets.linuxArm64
              : assets.linuxX64;
        if (!asset) throw new Error("This release has no archive for this computer's architecture");
        const base = join(
          home,
          ".local/share/shellbell/installs",
          `${process.platform}-${process.arch}`,
        );
        if (installation === "mac-cli") {
          const platform = check.release.platforms.macosArm64;
          if (!platform) throw new Error("Missing platform compatibility information");
          const os = await run("/usr/bin/sw_vers", ["-productVersion"], {
            env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
            timeout: 5000,
            maxBuffer: 1024,
          });
          requireUpdateMacOS(os.stdout, platform.minimumOS);
        } else {
          const platform =
            process.arch === "arm64"
              ? check.release.platforms.linuxArm64
              : check.release.platforms.linuxX64;
          if (!platform) throw new Error("Missing platform compatibility information");
          const glibc = await run("/usr/bin/getconf", ["GNU_LIBC_VERSION"], {
            env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
            timeout: 5000,
            maxBuffer: 1024,
          });
          requireUpdateGlibc(glibc.stdout, platform.minimumGlibc);
        }
        if ((await readlink(join(base, "current"))) !== currentVersion)
          throw new Error(
            "A different version is already selected; run ~/.local/bin/shellbell update instead",
          );
        const installer = join(base, currentVersion, "install.sh");
        const stat = await lstat(installer);
        if (
          !stat.isFile() ||
          stat.isSymbolicLink() ||
          stat.uid !== process.getuid!() ||
          (stat.mode & 0o7022) !== 0
        )
          throw new Error(
            "The installed CLI's update bootstrap is unsafe; use the official manual installer",
          );
        if (!options.yes && !(await confirm(check.release.version))) {
          console.log("Update cancelled.");
          return;
        }
        const stage = await mkdtemp(join(tmpdir(), "shellbell-update-"));
        try {
          const archive = join(stage, asset.name);
          console.log(`Downloading Shellbell ${check.release.version}…`);
          await downloadUpdate(client, asset, archive);
          const result = await run(
            "/bin/sh",
            [
              installer,
              "--archive",
              archive,
              "--sha256",
              asset.digest.slice(7),
              "--update-from",
              currentVersion,
              "--target-version",
              check.release.version,
            ],
            {
              env: { HOME: home, PATH: "/usr/bin:/bin", LANG: "C" },
              timeout: 600_000,
              maxBuffer: 64 * 1024,
            },
          );
          console.log(installerReport(result));
          console.log(
            "The new version is installed. Running sessions still use the previous runtime.",
          );
          console.log(
            "When ready to interrupt remote access, run: shellbell service stop; shellbell service install; shellbell service start",
          );
          console.log(
            "For a foreground process, stop it and run shellbell start again. Pairings are preserved.",
          );
        } finally {
          await rm(stage, { recursive: true, force: true });
        }
      },
    );
}
