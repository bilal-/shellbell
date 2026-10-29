import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fail, sha256, validVersion } from "./payload.mjs";

const scripts = dirname(fileURLToPath(import.meta.url));
const repo = resolve(scripts, "../../..");
const unset = "\nrelease_version=\n";

// The copy attached to a release names its version, so `curl … | sh` needs no options. A
// script generated from the qualified release record also pins its archives' checksums.
export function releaseInstaller(source, version, checksums) {
  if (!validVersion(version)) fail("invalid-version");
  if (source.split(unset).length !== 2) fail("installer-version-line");
  let script = source.replace(unset, `\nrelease_version=${version}\n`);
  if (checksums) {
    for (const arch of ["arm64", "x64"]) {
      const line = `\nrelease_sha256_${arch}=\n`;
      if (!/^[a-f0-9]{64}$/.test(checksums[arch] ?? "")) fail("invalid-checksum");
      if (script.split(line).length !== 2) fail("installer-checksum-line");
      script = script.replace(line, `\nrelease_sha256_${arch}=${checksums[arch]}\n`);
    }
  }
  return script;
}

export function writeReleaseInstaller({ output }) {
  if (!isAbsolute(output ?? "")) fail("absolute-path-required");
  if (existsSync(output)) fail("output-exists");
  const { version } = JSON.parse(readFileSync(join(repo, "apps/agent/package.json"), "utf8"));
  const script = releaseInstaller(
    readFileSync(join(repo, "apps/linux/install.sh"), "utf8"),
    version,
  );
  mkdirSync(output, { mode: 0o755 });
  const installer = join(output, "install.sh");
  writeFileSync(installer, script, { flag: "wx", mode: 0o644 });
  const checksum = sha256(Buffer.from(script));
  writeFileSync(`${installer}.sha256`, `${checksum}  install.sh\n`, { flag: "wx", mode: 0o644 });
  return { installer, sha256: checksum, version };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 2 || args[0] !== "--output") fail("usage: --output ABS_NEW_DIR");
    console.log(JSON.stringify(writeReleaseInstaller({ output: args[1] }), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
