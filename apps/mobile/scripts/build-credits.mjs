// Generates the Open-source credits screen's data from what the app actually ships:
// - JavaScript packages: every package with a module in the Android or iOS bundle, read from a
//   real `expo export`'s source maps, so build tools never appear and nothing shipped is missed;
// - native libraries: credits/native.json, recorded from the Android and iOS builds by
//   scripts/credits-native.mjs.
// The terminal page's own libraries and font are credited by scripts/build-terminal.mjs.
//
// `pnpm credits:build` writes src/credits/gen/credits.json; `pnpm credits:check` fails if that
// file is stale, or if a shipped package has no licence or one outside the allow-list.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "src/credits/gen/credits.json");
const check = process.argv.includes("--check");

/** Licences the app may ship under; anything else needs a review before it lands. */
const ALLOWED = new Set([
  "MIT",
  "ISC",
  "0BSD",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "Apache-2.0",
  "BlueOak-1.0.0",
  "Unlicense",
  "CC0-1.0",
  "MPL-2.0",
  "Python-2.0",
  "BSL-1.0",
  "Zlib",
  "OFL-1.1",
]);
const canonical = (id) => {
  const file = path.join(root, "credits/licenses", `${id}.txt`);
  return existsSync(file) ? readFileSync(file, "utf8") : null;
};
/** A standard licence text with its `<year> <owner>` line naming the actual holder. */
function standard(id, holder) {
  const text = canonical(id);
  if (!text) return null;
  const filled = text.replace(/^(Copyright(?: \(c\))?) <year> <[^>]+>\.?\s*$/m, `$1 ${holder}`);
  if (/<(?:year|owner|copyright holders)>/.test(filled))
    throw new Error(`The ${id} text still has a placeholder for ${holder}`);
  return filled;
}
const notice = (id) => readFileSync(path.join(root, "credits/notices", `${id}.txt`), "utf8");
/** How the screen names licences that have no SPDX ID. */
const LICENSE_LABELS = {
  "LicenseRef-WebRTC": "BSD-3-Clause, with third-party notices",
  "LicenseRef-Android-SDK": "Android SDK License",
  "LicenseRef-ML-Kit": "ML Kit Terms of Service",
  "LicenseRef-React-Native-Dependencies": "Apache-2.0, BSL-1.0, BSD-3-Clause, MIT",
};
/** Standard licence texts a combined notice's components use, appended after it. */
const NOTICE_LICENSES = {
  "LicenseRef-WebRTC": ["Apache-2.0", "ISC", "OpenSSL", "BSD-3-Clause", "BSD-2-Clause"],
  "LicenseRef-React-Native-Dependencies": ["Apache-2.0", "BSL-1.0", "BSD-3-Clause", "MIT"],
};
/** Readable names for native libraries better known by another name than their Maven group. */
const NATIVE_NAMES = {
  "org.jitsi": "WebRTC (org.jitsi)",
  JitsiWebRTC: "WebRTC (JitsiWebRTC)",
  "com.facebook.react": "React Native (com.facebook.react)",
  "com.facebook.hermes": "Hermes (com.facebook.hermes)",
  "hermes-engine": "Hermes (hermes-engine)",
  "com.google.mlkit": "ML Kit (com.google.mlkit)",
  "com.google.android.gms": "Google Play services (com.google.android.gms)",
};

/** `(MIT OR Apache-2.0)` is allowed if any choice is; `MIT AND X` only if all parts are. */
function allowed(expression) {
  const clean = expression.replace(/[()]/g, "").trim();
  if (clean.includes(" OR ")) return clean.split(" OR ").some(allowed);
  return clean.split(" AND ").every((id) => ALLOWED.has(id.trim()));
}

function exportBundles() {
  const dir = mkdtempSync(path.join(tmpdir(), "shellbell-credits-"));
  try {
    execFileSync(
      "npx",
      [
        "expo",
        "export",
        "--platform",
        "android",
        "--platform",
        "ios",
        "--source-maps",
        "--no-minify",
        "--output-dir",
        dir,
      ],
      { cwd: root, stdio: ["ignore", "ignore", "inherit"], env: { ...process.env, CI: "1" } },
    );
    const maps = [];
    const walk = (at) => {
      for (const entry of readdirSync(at, { withFileTypes: true })) {
        const next = path.join(at, entry.name);
        if (entry.isDirectory()) walk(next);
        else if (entry.name.endsWith(".map")) maps.push(JSON.parse(readFileSync(next, "utf8")));
      }
    };
    walk(dir);
    if (maps.length < 2) throw new Error("expo export produced no source maps for both platforms");
    return maps;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Each package directory with at least one module in a bundle. */
function shippedPackages(maps) {
  const dirs = new Set();
  for (const map of maps)
    for (const source of map.sources) {
      // Exports name sources from the server root with a leading slash, or relative to the app.
      const absolute = [path.resolve(root, "../.."), root]
        .map((base) => path.join(base, source))
        .find((candidate) => existsSync(candidate));
      if (!absolute) continue;
      const at = absolute.lastIndexOf(`${path.sep}node_modules${path.sep}`);
      if (at < 0) continue;
      const rest = absolute.slice(at + "/node_modules/".length).split(path.sep);
      const name = rest[0].startsWith("@") ? `${rest[0]}/${rest[1]}` : rest[0];
      dirs.add(path.join(absolute.slice(0, at), "node_modules", name));
    }
  return [...dirs];
}

function licenseOf(pkg) {
  if (typeof pkg.license === "string") return pkg.license;
  if (pkg.license?.type) return pkg.license.type;
  if (Array.isArray(pkg.licenses)) return pkg.licenses.map((l) => l.type ?? l).join(" OR ");
  return null;
}

function packageCredit(dir) {
  const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
  if (pkg.name.startsWith("@shellbell/")) return null;
  const license = licenseOf(pkg);
  if (!license) throw new Error(`${pkg.name}@${pkg.version} declares no licence`);
  if (!allowed(license))
    throw new Error(`${pkg.name}@${pkg.version} is ${license}, outside the allowed licences`);
  const files = readdirSync(dir)
    .filter((name) => /^(licen[cs]e|copying|notice)(\.|-|$)/i.test(name))
    .sort();
  let text = files.map((name) => readFileSync(path.join(dir, name), "utf8").trim()).join("\n\n");
  if (!text) {
    // No licence file in the package: the declared licence's standard text, with the holder
    // the package names, as the licence requires.
    const id = license
      .replace(/[()]/g, "")
      .split(/ OR | AND /)[0]
      .trim();
    const holder = (
      typeof pkg.author === "string" ? pkg.author : (pkg.author?.name ?? `The ${pkg.name} authors`)
    )
      .replace(/\s*[<(][^>)]*[>)]/g, "")
      .trim();
    const body = standard(id, holder);
    if (!body) throw new Error(`${pkg.name}@${pkg.version} has no licence file or ${id} text`);
    text = `${license}\n\n${body.trim()}`;
  }
  return { name: pkg.name, version: pkg.version, license, text };
}

function generate() {
  const texts = [];
  const indexes = new Map();
  const textIndex = (text) => {
    const key = createHash("sha256").update(text).digest("hex");
    if (!indexes.has(key)) {
      indexes.set(key, texts.length);
      texts.push(text);
    }
    return indexes.get(key);
  };
  const native = JSON.parse(readFileSync(path.join(root, "credits/native.json"), "utf8"));
  // Native-only modules the bundles don't reach, found from the app as autolinking does.
  const moduleDirs = native.modules.map((name) => {
    for (let dir = root; path.dirname(dir) !== dir; dir = path.dirname(dir)) {
      const candidate = path.join(dir, "node_modules", name);
      if (existsSync(path.join(candidate, "package.json"))) return candidate;
    }
    throw new Error(`Native module ${name} isn't installed`);
  });
  const packages = [...shippedPackages(exportBundles()), ...moduleDirs]
    .map(packageCredit)
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  const unique = [...new Map(packages.map((p) => [`${p.name}@${p.version}`, p])).values()];
  const nativeText = (license, holder) => {
    if (license.startsWith("LicenseRef-"))
      return [
        notice(license),
        // Each component's own holder is named in the notice; the standard texts follow it.
        ...(NOTICE_LICENSES[license] ?? []).map((id) => standard(id, "the component's authors")),
      ].join("\n\n");
    const parts = license.split(" OR ").map((id) => standard(id.trim(), holder));
    if (parts.some((part) => !part)) throw new Error(`No text for native licence ${license}`);
    return parts.join("\n\n");
  };
  /** Maven libraries grouped by group ID, so 250 Jetpack artifacts read as a few dozen rows. */
  const grouped = (libraries) => {
    const groups = new Map();
    for (const library of libraries) {
      const group = library.name.split(":")[0];
      const entry = groups.get(group) ?? {
        name: group,
        versions: new Set(),
        licenses: new Set(),
        holders: new Set(),
      };
      entry.versions.add(library.version);
      entry.licenses.add(library.license);
      entry.holders.add(library.holder);
      groups.set(group, entry);
    }
    return [...groups.values()].map((entry) => ({
      name: entry.name,
      version: [...entry.versions].sort().join(", "),
      license: [...entry.licenses].sort().join("; "),
      holder: [...entry.holders].sort().join(", "),
    }));
  };
  const nativeItems = (items) =>
    items.map(({ holder, ...item }) => ({
      ...item,
      name: NATIVE_NAMES[item.name] ?? item.name,
      license: item.license
        .split("; ")
        .map((id) => LICENSE_LABELS[id] ?? id)
        .join("; "),
      text: textIndex(
        item.license
          .split("; ")
          .map((license) => nativeText(license, holder))
          .join("\n\n"),
      ),
    }));
  const reactNative = {
    name: "React Native's native libraries",
    version: "",
    license: "LicenseRef-React-Native-Dependencies",
    holder: "",
  };
  const credits = {
    texts,
    sections: [
      {
        title: "JavaScript libraries",
        items: unique.map(({ text, ...item }) => ({ ...item, text: textIndex(text) })),
      },
      {
        title: "Android libraries",
        items: nativeItems([...grouped(native.android), reactNative]),
      },
      { title: "iOS libraries", items: nativeItems(native.ios) },
    ],
  };
  return `${JSON.stringify(credits, null, 1)}\n`;
}

const generated = generate();
if (check) {
  if (!existsSync(output) || readFileSync(output, "utf8") !== generated) {
    console.error("Open-source credits are stale. Run: pnpm -F @shellbell/mobile credits:build");
    process.exit(1);
  }
  console.log("Open-source credits are current");
} else {
  writeFileSync(output, generated);
  console.log(`Open-source credits generated (${generated.length} bytes)`);
}
