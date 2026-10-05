import { execFile } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { loadSupplement, repoRoot } from "../../macos/scripts/package-lib.mjs";
import { fail, runtimeManifest, sha256, validPath } from "./payload.mjs";

const exec = promisify(execFile);
export async function run(file, args, options = {}) {
  const { stdout } = await exec(file, args, {
    timeout: 120000,
    maxBuffer: 4 * 1024 * 1024,
    ...options,
  });
  return stdout.trim();
}
export async function verifyRuntimeArchive(path, arch) {
  const expected = runtimeManifest.archives[arch];
  if (!expected) fail("runtime-architecture");
  const st = lstatSync(path);
  if (!st.isFile() || st.isSymbolicLink() || st.size > 128 * 1024 * 1024) fail("runtime-archive");
  if (sha256(readFileSync(path)) !== expected.sha256) fail("runtime-checksum");
  return expected;
}
export function verifyElf(path, arch) {
  const bytes = readFileSync(path);
  if (
    bytes.length < 64 ||
    bytes.subarray(0, 4).toString("hex") !== "7f454c46" ||
    bytes[4] !== 2 ||
    bytes[5] !== 1 ||
    bytes.readUInt16LE(18) !== { x64: 62, arm64: 183 }[arch]
  )
    fail("runtime-architecture");
}
export function copyPayloadTree(source, destination, boundary = source) {
  const allowed = realpathSync(boundary);
  let count = 0;
  let bytes = 0;
  function visit(from, to, ancestors) {
    const canonical = realpathSync(from);
    const rel = relative(allowed, canonical);
    if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) fail("dependency-escape");
    if (ancestors.has(canonical) || ++count > 20000) fail("dependency-cycle-or-size");
    const st = lstatSync(canonical);
    if (st.isDirectory()) {
      mkdirSync(to, { mode: 0o755 });
      const next = new Set([...ancestors, canonical]);
      for (const name of readdirSync(canonical).sort()) {
        if (name === ".bin" || name === ".package-lock.json") continue;
        if (!validPath(name)) fail("dependency-path");
        visit(join(canonical, name), join(to, name), next);
      }
    } else if (st.isFile()) {
      bytes += st.size;
      if (st.size > 256 * 1024 * 1024 || bytes > 1024 * 1024 * 1024) fail("dependency-size");
      writeFileSync(to, readFileSync(canonical), {
        flag: "wx",
        mode: st.mode & 0o111 ? 0o755 : 0o644,
      });
    } else fail("dependency-special-file");
  }
  visit(resolve(source), resolve(destination), new Set());
}
export function collectLicenses(agent, destination, sourceLicense) {
  mkdirSync(destination, { mode: 0o755 });
  writeFileSync(join(destination, "Shellbell-LICENSE"), readFileSync(sourceLicense), {
    mode: 0o644,
    flag: "wx",
  });
  const notices = [];
  function scan(directory) {
    for (const name of readdirSync(directory).sort()) {
      const p = join(directory, name);
      if (lstatSync(p).isDirectory()) scan(p);
      else if (name === "package.json") {
        const pkg = JSON.parse(readFileSync(p, "utf8"));
        if (!pkg.name || !pkg.version) continue;
        const base = dirname(p);
        const licenses = readdirSync(base).filter(
          (f) =>
            /^(?:licen[cs]e|copying|notice)(?:[.-].*)?$/i.test(f) &&
            lstatSync(join(base, f)).isFile(),
        );
        const supplement = licenses.length ? [] : loadSupplement(repoRoot, pkg);
        const files = licenses.map((f, index) => {
          const target = `${pkg.name.replaceAll("/", "_")}--${pkg.version}--${index}.txt`;
          if (!validPath(target)) fail("license-path");
          const bytes = readFileSync(join(base, f));
          try {
            writeFileSync(join(destination, target), bytes, { mode: 0o644, flag: "wx" });
          } catch (error) {
            if (error.code !== "EEXIST" || !bytes.equals(readFileSync(join(destination, target))))
              throw error;
          }
          return target;
        });
        for (const [index, item] of supplement.entries()) {
          const target = `${pkg.name.replaceAll("/", "_")}--${pkg.version}--supplement-${index}.txt`;
          if (!validPath(target)) fail("license-path");
          writeFileSync(join(destination, target), readFileSync(item.path), {
            mode: 0o644,
            flag: "wx",
          });
          files.push(target);
        }
        notices.push({
          name: pkg.name,
          version: pkg.version,
          files,
          ...(supplement.length
            ? { sources: supplement.map(({ source, sha256 }) => ({ source, sha256 })) }
            : {}),
        });
      }
    }
  }
  scan(join(agent, "node_modules"));
  writeFileSync(join(destination, "index.json"), `${JSON.stringify(notices, null, 2)}\n`, {
    flag: "wx",
    mode: 0o644,
  });
  return notices;
}
