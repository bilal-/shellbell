import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { releaseInstaller } from "../linux/scripts/release-installer.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
function requireFact(condition, message) {
  if (!condition) throw new Error(message);
}
export function createInstaller(release) {
  requireFact(
    release?.schemaVersion === 1 &&
      release.component === "computer" &&
      release.channel === "stable",
    "Stable computer release required",
  );
  requireFact(
    typeof release.version === "string" &&
      release.version.length <= 32 &&
      VERSION.test(release.version) &&
      release.tag === `shellbell@${release.version}`,
    "Invalid computer version",
  );
  const mac = release.platforms?.macosArm64;
  requireFact(
    mac?.signed === true &&
      mac.notarized === true &&
      mac.asset === `Shellbell-${release.version}-arm64.dmg` &&
      /^[a-f0-9]{64}$/.test(mac.sha256) &&
      /^\d{1,3}\.\d{1,3}(?:\.\d{1,3})?$/.test(mac.minimumOS),
    "Qualified signed Mac artifact required",
  );
  for (const [key, arch] of [
    ["linuxArm64", "arm64"],
    ["linuxX64", "x64"],
  ]) {
    const linux = release.platforms[key];
    requireFact(
      linux?.asset === `shellbell-${release.version}-linux-${arch}.tar.gz` &&
        /^[a-f0-9]{64}$/.test(linux.sha256),
      "Both Linux archives required",
    );
  }
  const engine = readFileSync(new URL("./macos-install.mjs", import.meta.url), "utf8");
  const bootstrap = readFileSync(new URL("./macos.sh", import.meta.url), "utf8");
  const linux = releaseInstaller(
    readFileSync(new URL("../linux/install.sh", import.meta.url), "utf8"),
    release.version,
  );
  const delimiter = `SHELLBELL_${sha256(engine + bootstrap).toUpperCase()}`;
  const url = `https://github.com/bilal-/shellbell/releases/download/${encodeURIComponent(release.tag)}/${mac.asset}`;
  return `#!/bin/sh
# Shellbell CLI installer. Generated from the qualified computer release record.
set -eu
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH
unset NODE_OPTIONS NODE_PATH ENV BASH_ENV CDPATH
if [ "$#" = 1 ] && [ "$1" = --help ]; then
  printf '%s\\n' 'Install Shellbell ${release.version} CLI on Apple silicon macOS ${mac.minimumOS}+ or Linux ARM64/x64.' 'Run as your normal user. Installation does not start a service or create an identity.'
  exit 0
fi
[ "$#" = 0 ] || { echo 'Shellbell: no options supported; use --help' >&2; exit 1; }
case "$(uname -s)/$(uname -m)" in
Linux/aarch64|Linux/x86_64)
${linux}
;;
Darwin/arm64)
  [ "$(id -u)" != 0 ] && [ "$(id -u)" = "$(id -ru)" ] || { echo 'Shellbell: run without sudo' >&2; exit 1; }
  sw_vers -productVersion | awk -v minimum='${mac.minimumOS}' '{ split($0,a,"."); split(minimum,b,"."); for(i=1;i<=3;i++){if(a[i]+0>b[i]+0)exit 0;if(a[i]+0<b[i]+0)exit 1} }' || { echo 'Shellbell: macOS ${mac.minimumOS} or newer is required' >&2; exit 1; }
  umask 077
  stage=$(mktemp -d /private/tmp/shellbell-cli-install.XXXXXXXX)
  trap 'rm -rf -- "$stage"' EXIT
  trap 'exit 1' HUP INT TERM
  cat > "$stage/install.mjs" <<'${delimiter}_JS'
${engine}
${delimiter}_JS
  cat > "$stage/install.sh" <<'${delimiter}_SH'
${bootstrap}
${delimiter}_SH
  curl --proto '=https' --proto-redir '=https' -fL --connect-timeout 15 --max-time 180 --max-filesize 268435456 -o "$stage/release.dmg" '${url}'
  /bin/sh "$stage/install.sh" --archive "$stage/release.dmg" --sha256 '${mac.sha256}' --target-version '${release.version}'
;;
*) echo 'Shellbell: supported platforms are Apple silicon macOS and Linux ARM64/x64' >&2; exit 1 ;;
esac
`;
}
export function writeInstaller({ manifest, output }) {
  requireFact(
    isAbsolute(manifest ?? "") && isAbsolute(output ?? ""),
    "Absolute manifest and new output directory required",
  );
  const release = JSON.parse(readFileSync(manifest, "utf8"));
  requireFact(/^[a-f0-9]{40}$/.test(release.sourceCommit), "Exact source commit required");
  const script = createInstaller(release);
  mkdirSync(output, { mode: 0o755 });
  const artifact = {
    asset: "install-cli.sh",
    sha256: sha256(script),
    platforms: ["darwin-arm64", "linux-arm64", "linux-x64"],
  };
  writeFileSync(join(output, artifact.asset), script, { flag: "wx", mode: 0o644 });
  writeFileSync(
    join(output, `${artifact.asset}.sha256`),
    `${artifact.sha256}  ${artifact.asset}\n`,
    { flag: "wx" },
  );
  // Do not add fields to computer-release.json: installed v1 updaters use a
  // strict schema. Website discovery verifies this separate release asset.
  const record = {
    schemaVersion: 1,
    component: "cli-installer",
    version: release.version,
    tag: release.tag,
    sourceCommit: release.sourceCommit,
    installer: artifact,
  };
  writeFileSync(join(output, "cli-installer.json"), `${JSON.stringify(record, null, 2)}\n`, {
    flag: "wx",
    mode: 0o644,
  });
  return record;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    requireFact(
      args.length === 4 && args[0] === "--manifest" && args[2] === "--output",
      "Use --manifest ABS_COMPUTER_RELEASE_JSON --output ABS_NEW_DIR",
    );
    console.log(JSON.stringify(writeInstaller({ manifest: args[1], output: args[3] }), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
