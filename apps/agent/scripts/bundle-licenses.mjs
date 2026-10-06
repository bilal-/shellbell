import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import bundledDependencies from "../bundled-dependencies.json" with { type: "json" };

const agentRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(agentRoot, "../..");

export function bundleLicenseFiles() {
  return [
    { target: "Shellbell-LICENSE", bytes: readFileSync(join(repoRoot, "LICENSE")) },
    ...bundledDependencies.map((name) => {
      const source = join(repoRoot, "node_modules", name);
      const pkg = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
      if (pkg.name !== name || typeof pkg.version !== "string")
        throw new Error(`Invalid bundled dependency metadata: ${name}`);
      return {
        target: `${name.replaceAll("/", "_")}--${pkg.version}--LICENSE`,
        bytes: readFileSync(join(source, "LICENSE")),
      };
    }),
  ];
}

export function writeBundleLicenses(destination) {
  mkdirSync(destination, { recursive: true });
  for (const { target, bytes } of bundleLicenseFiles())
    writeFileSync(join(destination, target), bytes, { mode: 0o644, flag: "wx" });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  writeBundleLicenses(join(agentRoot, "dist/licenses"));
