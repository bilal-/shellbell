import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, normalize, relative, sep } from "node:path";

export type ServiceRuntime = {
  nodePath: string;
  cliPath: string;
  packageRoot: string;
};

const MAX_MANIFEST_BYTES = 1024 * 1024;
const CACHE_COMPONENTS = new Set([".npm", "_npx", "dlx"]);
const CACHE_ENVIRONMENT_KEYS = [["npm", "config", "cache"].join("_"), "NPM_CONFIG_CACHE"];
const REMEDY =
  "install a built Shellbell package in a durable directory, then rerun service install";

function invalid(path: string, problem: string): never {
  throw new Error(`Shellbell service runtime at ${path} ${problem}; ${REMEDY}`);
}

function canonicalRoot(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return normalize(path);
  }
}

function temporaryRoots(): string[] {
  const roots = [tmpdir(), "/tmp", "/private/tmp", "/var/tmp", "/private/var/tmp"];
  for (const name of CACHE_ENVIRONMENT_KEYS) {
    const value = process.env[name];
    if (value && isAbsolute(value)) roots.push(value);
  }
  return [...new Set(roots.flatMap((root) => [normalize(root), canonicalRoot(root)]))];
}

function isContainedBy(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function assertDurable(path: string): void {
  const normalized = normalize(path);
  if (
    normalized.split(sep).some((component) => CACHE_COMPONENTS.has(component)) ||
    temporaryRoots().some((root) => isContainedBy(normalized, root))
  ) {
    invalid(path, "is in a temporary or package-manager cache location");
  }
}

function canonicalFile(path: string, kind: "Node executable" | "CLI entrypoint"): string {
  if (!isAbsolute(path)) invalid(path, `${kind} path must be absolute`);
  assertDurable(path);

  let canonical: string;
  try {
    canonical = realpathSync(path);
  } catch {
    invalid(path, `${kind} does not exist`);
  }
  assertDurable(canonical);

  const stat = (() => {
    try {
      return statSync(canonical);
    } catch {
      return invalid(canonical, `${kind} does not exist`);
    }
  })();
  if (!stat.isFile()) invalid(canonical, `${kind} must be a regular file`);
  return canonical;
}

function assertAccess(path: string, mode: number, problem: string): void {
  try {
    accessSync(path, mode);
  } catch {
    invalid(path, problem);
  }
}

function readManifest(packageRoot: string): Record<string, unknown> {
  const manifestPath = `${packageRoot}${sep}package.json`;
  const stat = (() => {
    try {
      return statSync(manifestPath);
    } catch {
      return invalid(manifestPath, "package.json is missing");
    }
  })();
  if (!stat.isFile()) invalid(manifestPath, "package.json must be a regular file");
  if (stat.size > MAX_MANIFEST_BYTES) invalid(manifestPath, "package.json exceeds 1 MiB");

  let raw: string;
  try {
    raw = readFileSync(manifestPath, "utf8");
  } catch {
    invalid(manifestPath, "package.json is not readable");
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(raw);
  } catch {
    invalid(manifestPath, "package.json is not valid JSON");
  }
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
    invalid(manifestPath, "package.json is not a valid manifest");
  }
  return manifest as Record<string, unknown>;
}

function hasShellbellBin(manifest: Record<string, unknown>): boolean {
  const bin = manifest.bin;
  const target =
    typeof bin === "string"
      ? bin
      : typeof bin === "object" && bin !== null && !Array.isArray(bin)
        ? (bin as Record<string, unknown>).shellbell
        : undefined;
  return target === "dist/cli.js" || target === "./dist/cli.js";
}

export function resolveServiceRuntime(
  nodePath: string = process.execPath,
  cliPath: string = process.argv[1] ?? "",
): ServiceRuntime {
  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "", 10);
  if (!Number.isInteger(nodeMajor) || nodeMajor < 22) {
    invalid(
      process.execPath,
      "requires the currently running Node.js major version to be at least 22",
    );
  }

  const canonicalNode = canonicalFile(nodePath, "Node executable");
  assertAccess(canonicalNode, constants.X_OK, "Node executable is not executable");

  const canonicalCli = canonicalFile(cliPath, "CLI entrypoint");
  assertAccess(canonicalCli, constants.R_OK, "CLI entrypoint is not readable");
  if (basename(canonicalCli) !== "cli.js" || basename(dirname(canonicalCli)) !== "dist") {
    invalid(canonicalCli, "is not an installed built CLI entrypoint");
  }

  const packageRoot = dirname(dirname(canonicalCli));
  const sourceEntrypoint = `${packageRoot}${sep}src${sep}cli.ts`;
  if (existsSync(sourceEntrypoint)) {
    invalid(packageRoot, "is a source checkout rather than an installed built package");
  }

  const manifest = readManifest(packageRoot);
  if (manifest.name !== "shellbell") {
    invalid(`${packageRoot}${sep}package.json`, "has the wrong package name");
  }
  if (!hasShellbellBin(manifest)) {
    invalid(`${packageRoot}${sep}package.json`, "does not declare the Shellbell bin entrypoint");
  }

  return { nodePath: canonicalNode, cliPath: canonicalCli, packageRoot };
}
