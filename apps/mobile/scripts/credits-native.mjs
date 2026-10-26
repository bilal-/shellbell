// Records the native libraries the Android and iOS builds ship, with each one's licence, in
// credits/native.json. Run it after native dependencies change (`pnpm credits:native`, with the
// generated android/ and ios/ projects present); `pnpm credits:check` then holds the generated
// credits to it. Licences come from each Maven POM (following parent POMs) and CocoaPods'
// podspecs, never from a guess; anything unrecognised stops the run.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cache = path.join(homedir(), ".gradle/caches/modules-2/files-2.1");

/** POM licence names and URLs, as projects write them, to SPDX IDs. */
const LICENSE_NAMES = [
  [/apache|apache-2\.0|LICENSE-APACHE/i, "Apache-2.0"],
  [/\bmit\b|LICENSE-MIT/i, "MIT"],
  [/bsd.*3|3.?clause|new bsd|revised bsd/i, "BSD-3-Clause"],
  [/bsd.*2|2.?clause|simplified bsd/i, "BSD-2-Clause"],
  [/^bsd( license)?\b/i, "BSD-3-Clause"],
  [
    /android software development kit|developer\.android\.com\/studio\/terms/i,
    "LicenseRef-Android-SDK",
  ],
  [/ml kit terms|developers\.google\.com\/ml-kit\/terms/i, "LicenseRef-ML-Kit"],
  [/eclipse public license.*2/i, "EPL-2.0"],
];

/** Libraries whose POMs carry no licence; each entry names the source it was checked against. */
const POM_OVERRIDES = {
  // Facebook's Android artifacts publish no <licenses>; their repositories are MIT licensed.
  "com.facebook.device.yearclass": "MIT",
  "com.facebook.infer.annotation": "MIT",
  "com.facebook.fbjni": "Apache-2.0",
  "com.facebook.soloader": "Apache-2.0",
  "com.facebook.yoga": "MIT",
  "com.facebook.hermes": "MIT",
  "com.facebook.react": "MIT",
  "com.facebook.fresco": "MIT",
  // Google Play services, Firebase transport and ML Kit ship under Google's SDK terms.
  "com.google.android.gms": "LicenseRef-Android-SDK",
  "com.google.android.datatransport": "Apache-2.0",
  "com.google.android.odml": "LicenseRef-Android-SDK",
  "com.google.mlkit": "LicenseRef-ML-Kit",
  "com.google.firebase": "Apache-2.0",
  "com.android.installreferrer": "LicenseRef-Android-SDK",
  "io.github.lukmccall.pika": "MIT",
  "me.leolin": "Apache-2.0",
  "org.brotli": "MIT",
  "com.squareup.zstd": "Apache-2.0",
};

const REPOSITORIES = ["https://dl.google.com/android/maven2", "https://repo1.maven.org/maven2"];
const fetched = path.join(tmpdir(), "shellbell-credits-poms");

/** A POM from Gradle's cache, or fetched once: Gradle skips POMs it resolved from module files. */
async function pom(group, artifact, version) {
  const dir = path.join(cache, group, artifact, version);
  if (existsSync(dir))
    for (const hash of readdirSync(dir)) {
      const file = path.join(dir, hash, `${artifact}-${version}.pom`);
      if (existsSync(file)) return readFileSync(file, "utf8");
    }
  const saved = path.join(fetched, `${group}__${artifact}__${version}.pom`);
  if (existsSync(saved)) return readFileSync(saved, "utf8");
  for (const repository of REPOSITORIES) {
    const url = `${repository}/${group.replaceAll(".", "/")}/${artifact}/${version}/${artifact}-${version}.pom`;
    const response = await fetch(url);
    if (!response.ok) continue;
    const text = await response.text();
    mkdirSync(fetched, { recursive: true });
    writeFileSync(saved, text);
    return text;
  }
  return null;
}

async function pomLicenses(group, artifact, version, depth = 0) {
  const text = depth > 6 ? null : await pom(group, artifact, version);
  if (!text) return [];
  const block = /<licenses>([\s\S]*?)<\/licenses>/.exec(text)?.[1];
  if (block)
    return [...block.matchAll(/<license>([\s\S]*?)<\/license>/g)].map((m) =>
      [/<name>([\s\S]*?)<\/name>/, /<url>([\s\S]*?)<\/url>/]
        .map((re) => re.exec(m[1])?.[1]?.trim() ?? "")
        .join(" "),
    );
  const parent = /<parent>([\s\S]*?)<\/parent>/.exec(text)?.[1];
  if (!parent) return [];
  const field = (name) => new RegExp(`<${name}>([^<]+)</${name}>`).exec(parent)?.[1]?.trim();
  return pomLicenses(field("groupId"), field("artifactId"), field("version"), depth + 1);
}

function spdx(text) {
  return LICENSE_NAMES.find(([pattern]) => pattern.test(text))?.[1];
}

async function android() {
  const output = execFileSync(
    "./gradlew",
    ["-q", ":app:dependencies", "--configuration", "releaseRuntimeClasspath"],
    { cwd: path.join(root, "android"), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  const found = new Map();
  for (const match of output.matchAll(/([\w.-]+):([\w.-]+):([\w.+-]+)(?: -> ([\w.+-]+))?/g)) {
    const [, group, artifact, requested, resolved] = match;
    // Expo's own modules are credited with their npm packages.
    if (group === "host.exp.exponent" || group.startsWith("expo.modules.")) continue;
    const version = resolved ?? requested;
    const key = `${group}:${artifact}`;
    // A later line without `->` repeats the request, not the version Gradle chose.
    if (!/^\d/.test(version) || (!resolved && found.has(key))) continue;
    found.set(key, { group, artifact, version });
  }
  const libraries = [];
  const unknown = [];
  for (const { group, artifact, version } of [...found.values()].sort((a, b) =>
    `${a.group}:${a.artifact}`.localeCompare(`${b.group}:${b.artifact}`),
  )) {
    const named = await pomLicenses(group, artifact, version);
    const override = Object.entries(POM_OVERRIDES).find(
      ([prefix]) => group === prefix || group.startsWith(`${prefix}.`),
    )?.[1];
    const licenses = [...new Set(named.map(spdx).filter(Boolean))];
    // Jitsi's POM names its packaging's licences; the library inside is Google's WebRTC.
    const license =
      group === "org.jitsi"
        ? "LicenseRef-WebRTC"
        : licenses.length
          ? licenses.join(" OR ")
          : override;
    if (!license)
      unknown.push(`${group}:${artifact}:${version} (${named.join("; ") || "no licence"})`);
    else libraries.push({ name: `${group}:${artifact}`, version, license });
  }
  if (unknown.length)
    throw new Error(`Android libraries without a known licence:\n${unknown.join("\n")}`);
  // Autolinked modules are npm packages; some ship only native code, so the JS bundle misses
  // them. Gradle's project folders lead to each one's package.json.
  const projects = execFileSync("./gradlew", ["-q", "projects"], {
    cwd: path.join(root, "android"),
    encoding: "utf8",
  });
  const modules = [];
  for (const match of projects.matchAll(/project ':([\w.-]+)' - (\S+)/g)) {
    let dir = path.join(root, "android", match[2]);
    while (!existsSync(path.join(dir, "package.json")) && path.dirname(dir) !== dir)
      dir = path.dirname(dir);
    const name = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")).name;
    if (!/^(@shellbell\/|shellbell-)/.test(name) && !modules.includes(name)) modules.push(name);
  }
  modules.sort();
  return { libraries, modules };
}

/** Third-party pods; Expo and React Native modules are credited through their npm packages. */
const PODS = {
  "hermes-engine": "MIT",
  JitsiWebRTC: "LicenseRef-WebRTC",
  ReactNativeDependencies: "LicenseRef-React-Native-Dependencies",
  "React-Core-prebuilt": "MIT",
  ZXingObjC: "Apache-2.0",
};

function ios() {
  const lock = readFileSync(path.join(root, "ios/Podfile.lock"), "utf8");
  const pods = new Map();
  for (const match of lock.matchAll(/^ {2}- ([\w.+-]+)(?:\/[\w.+-]+)? \(([\w.+-]+)\)/gm))
    pods.set(match[1], match[2]);
  return Object.entries(PODS)
    .filter(([name]) => pods.has(name))
    .map(([name, license]) => ({ name, version: pods.get(name), license }));
}

const { libraries, modules } = await android();
const native = { modules, android: libraries, ios: ios() };
writeFileSync(path.join(root, "credits/native.json"), `${JSON.stringify(native, null, 2)}\n`);
console.log(
  `Native credits: ${native.android.length} Android libraries, ${native.ios.length} pods`,
);
