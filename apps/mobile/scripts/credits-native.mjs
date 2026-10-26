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

/** The POM's licences, and who holds the copyright: its organization, else its developers. */
async function pomFacts(group, artifact, version, depth = 0) {
  const text = depth > 6 ? null : await pom(group, artifact, version);
  if (!text) return { licenses: [], holder: null };
  const block = /<licenses>([\s\S]*?)<\/licenses>/.exec(text)?.[1];
  const licenses = block
    ? [...block.matchAll(/<license>([\s\S]*?)<\/license>/g)].map((m) =>
        [/<name>([\s\S]*?)<\/name>/, /<url>([\s\S]*?)<\/url>/]
          .map((re) => re.exec(m[1])?.[1]?.trim() ?? "")
          .join(" "),
      )
    : [];
  const organization = /<name>([^<]+)<\/name>/
    .exec(/<organization>([\s\S]*?)<\/organization>/.exec(text)?.[1] ?? "")?.[1]
    ?.trim();
  const developers = /<developers>([\s\S]*?)<\/developers>/.exec(text)?.[1];
  const people = developers
    ? [...developers.matchAll(/<name>([^<]+)<\/name>/g)].map((m) => m[1].trim()).slice(0, 3)
    : [];
  const holder = organization ?? (people.length ? people.join(", ") : null);
  const parent = /<parent>([\s\S]*?)<\/parent>/.exec(text)?.[1];
  if ((licenses.length && holder) || !parent) return { licenses, holder };
  const field = (name) => new RegExp(`<${name}>([^<]+)</${name}>`).exec(parent)?.[1]?.trim();
  const inherited = await pomFacts(
    field("groupId"),
    field("artifactId"),
    field("version"),
    depth + 1,
  );
  return {
    licenses: licenses.length ? licenses : inherited.licenses,
    holder: holder ?? inherited.holder,
  };
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
    const { licenses: named, holder } = await pomFacts(group, artifact, version);
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
    else
      libraries.push({
        name: `${group}:${artifact}`,
        version,
        license,
        holder: holder ?? HOLDERS[group] ?? `The ${group} authors`,
      });
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

/** Copyright holders for groups whose POMs name none. */
const HOLDERS = {
  "com.facebook.react": "Meta Platforms, Inc. and affiliates",
  "com.facebook.hermes": "Meta Platforms, Inc. and affiliates",
  "com.facebook.yoga": "Meta Platforms, Inc. and affiliates",
  "com.facebook.fresco": "Meta Platforms, Inc. and affiliates",
  "com.facebook.infer.annotation": "Meta Platforms, Inc. and affiliates",
  "com.facebook.device.yearclass": "Meta Platforms, Inc. and affiliates",
  "org.brotli": "the Brotli Authors",
};

/** Third-party pods; Expo and React Native modules are credited through their npm packages. */
const PODS = {
  "hermes-engine": { license: "MIT", holder: "Meta Platforms, Inc. and affiliates" },
  JitsiWebRTC: { license: "LicenseRef-WebRTC", holder: "The WebRTC project authors" },
  ReactNativeDependencies: { license: "LicenseRef-React-Native-Dependencies", holder: "" },
  "React-Core-prebuilt": { license: "MIT", holder: "Meta Platforms, Inc. and affiliates" },
  ZXingObjC: { license: "Apache-2.0", holder: "ZXing authors" },
};

/**
 * Every pod, accounted for: an npm package's native module (credited with its package), the
 * app's own code, or a third-party pod in PODS. Anything else stops the run.
 */
function ios() {
  const dir = path.join(root, "ios");
  // A leading newline lets the first section be found like the rest.
  const lock = `\n${readFileSync(path.join(dir, "Podfile.lock"), "utf8")}`;
  const section = (name) => {
    const start = lock.indexOf(`\n${name}:\n`);
    if (start < 0) return "";
    const rest = lock.slice(start + name.length + 3);
    const end = rest.search(/\n[A-Z][A-Z ]+:/);
    return end < 0 ? rest : rest.slice(0, end);
  };
  const versions = new Map();
  for (const match of section("PODS").matchAll(
    /^ {2}- "?([\w.+-]+)(?:\/[\w.+-]+)? \(([\w.+-]+)\)/gm,
  ))
    versions.set(match[1], match[2]);
  const sources = new Map();
  for (const match of section("EXTERNAL SOURCES").matchAll(
    /^ {2}"?([\w.+-]+)"?:\n {4}:(?:path|podspec): "?([^"\n]+)"?/gm,
  ))
    sources.set(match[1], match[2]);
  const pods = [];
  const modules = new Set();
  const unknown = [];
  for (const [name, version] of [...versions].sort(([a], [b]) => a.localeCompare(b))) {
    if (PODS[name]) {
      pods.push({ name, version, ...PODS[name] });
      continue;
    }
    const source = sources.get(name);
    if (!source) {
      unknown.push(name);
      continue;
    }
    // The app's own generated code and modules.
    if (source.startsWith("build/generated/") || source.startsWith("../modules/shellbell-"))
      continue;
    let at = path.resolve(dir, source);
    if (at.endsWith(".podspec")) at = path.dirname(at);
    while (!existsSync(path.join(at, "package.json")) && path.dirname(at) !== at)
      at = path.dirname(at);
    const pkg = existsSync(path.join(at, "package.json"))
      ? JSON.parse(readFileSync(path.join(at, "package.json"), "utf8")).name
      : null;
    if (pkg && !/^(@shellbell\/|shellbell-)/.test(pkg)) modules.add(pkg);
    else if (!pkg) unknown.push(name);
  }
  if (unknown.length)
    throw new Error(`Pods without a known source or licence: ${unknown.join(", ")}`);
  return { pods, modules: [...modules].sort() };
}

const { libraries, modules } = await android();
const apple = ios();
const native = {
  modules: [...new Set([...modules, ...apple.modules])].sort(),
  android: libraries,
  ios: apple.pods,
};
writeFileSync(path.join(root, "credits/native.json"), `${JSON.stringify(native, null, 2)}\n`);
console.log(
  `Native credits: ${native.android.length} Android libraries, ${native.ios.length} pods`,
);
