#!/usr/bin/env node
// Publish gate for `shellbell`. Fails loudly rather than shipping a tarball that cannot install.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const pkg = require("../package.json");
const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const entries = ["cli.js", "native-controller.js", "native-service.js"];
const bundles = readdirSync(dist).filter((name) => name.endsWith(".js"));
const bundle = bundles.map((name) => readFileSync(join(dist, name), "utf8")).join("\n");
const fail = (msg) => {
  console.error(`check-bundle: ${msg}`);
  process.exitCode = 1;
};

for (const entry of entries)
  if (!readFileSync(join(dist, entry), "utf8").startsWith("#!/usr/bin/env node"))
    fail(`dist/${entry} missing shebang`);

// 1. Nothing may still import a workspace package: those are bundled, never published.
if (/["']@shellbell\/[^"']+["']/.test(bundle)) {
  fail("dist/cli.js still references @shellbell/* — it must be bundled (tsdown alwaysBundle)");
}

// 2. Every bare import left in the bundle must be a declared runtime dependency.
const deps = new Set(Object.keys(pkg.dependencies ?? {}));
const specifiers = new Set();
for (const m of bundle.matchAll(/\bfrom\s*["']([^"'.][^"']*)["']/g)) specifiers.add(m[1]);
for (const m of bundle.matchAll(/\brequire\(\s*["']([^"'.][^"']*)["']\s*\)/g)) specifiers.add(m[1]);
for (const m of bundle.matchAll(/\bimport\(\s*["']([^"'.][^"']*)["']\s*\)/g)) {
  specifiers.add(m[1]);
}
for (const spec of specifiers) {
  if (spec.startsWith("node:")) continue;
  const name = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
  if (!deps.has(name)) fail(`dist/cli.js imports "${spec}" which is not in dependencies`);
}

// 3. No workspace protocol may reach the tarball's manifest.
for (const [k, v] of Object.entries(pkg.dependencies ?? {})) {
  if (String(v).startsWith("workspace:"))
    fail(`dependency ${k} is "${v}" — move it to devDependencies`);
}

// 4. Nothing that looks like a credential may be in the bundle.
for (const marker of [
  "BEGIN PRIVATE KEY",
  "BEGIN RSA",
  "EXPO_ACCESS_TOKEN", // Legacy credential must stay out of published artifacts too.
  "FCM_SERVICE_ACCOUNT_JSON",
  "APNS_PRIVATE_KEY",
  "APNS_TEAM_ID",
  "APNS_KEY_ID",
  "APNS_TOPIC",
  "SHELLBELL_FCM_SERVICE_ACCOUNT_FILE",
  "SHELLBELL_APNS_PRIVATE_KEY_FILE",
  "SHELLBELL_APNS_TEAM_ID",
  "SHELLBELL_APNS_KEY_ID",
  "SHELLBELL_APNS_TOPIC",
  "npm_",
  "ExponentPushToken[",
]) {
  if (bundle.includes(marker)) fail(`dist/cli.js contains the marker ${JSON.stringify(marker)}`);
}

// Only static modes run here; all possible state roots belong to this fixture.
const fixture = mkdtempSync(join(tmpdir(), "sb-bundle-smoke-"));
try {
  for (const entry of entries) {
    for (const argument of ["--version", "--help"]) {
      const output = execFileSync(process.execPath, [join(dist, entry), argument], {
        encoding: "utf8",
        timeout: 5000,
        maxBuffer: 65536,
        env: {
          PATH: process.env.PATH,
          HOME: fixture,
          SHELLBELL_DIR: join(fixture, "state"),
          XDG_STATE_HOME: join(fixture, "xdg-state"),
          XDG_RUNTIME_DIR: join(fixture, "runtime"),
        },
      });
      if (argument === "--version" ? output.trim() !== pkg.version : !output.trim())
        fail(`${entry} ${argument} returned unexpected static output`);
      if (readdirSync(fixture).length) fail(`${entry} ${argument} initialized state`);
    }
  }
} catch {
  fail("isolated static entry smoke failed");
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
if (process.exitCode) process.exit(1);
console.log("check-bundle: ok");
