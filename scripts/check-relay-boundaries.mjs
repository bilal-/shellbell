import { readFileSync, realpathSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

// These dependencies already implement the protocol in web runtimes. New providers need adapters.
const approvedPackages = new Set([
  "@shellbell/protocol",
  "@noble/ciphers",
  "@noble/curves",
  "@noble/hashes",
  "cborg",
  "zod",
]);
const builtins = new Set(builtinModules.map((name) => name.replace(/^node:/, "")));
const sourceExtensions = [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"];

function within(path, directory) {
  const part = relative(directory, path);
  return part === "" || (!isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`));
}

function packageName(specifier) {
  return specifier.startsWith("@")
    ? specifier.split("/").slice(0, 2).join("/")
    : specifier.split("/")[0];
}

function resolvedPackageOwner(target) {
  const parts = target.split(sep);
  const start = parts.lastIndexOf("node_modules") + 1;
  if (start === 0 || !parts[start]) return undefined;
  const end = start + (parts[start].startsWith("@") ? 2 : 1);
  const name = parts.slice(start, end).join("/");
  try {
    // Use the installation's package boundary, not nested manifests such as zod/v4/core.
    const manifest = JSON.parse(
      readFileSync(resolve(parts.slice(0, end).join(sep), "package.json"), "utf8"),
    );
    return manifest.name === name ? name : undefined;
  } catch {
    return undefined;
  }
}

function forbidden(specifier) {
  return (
    specifier.startsWith("node:") ||
    builtins.has(specifier) ||
    specifier.startsWith("cloudflare:") ||
    specifier.startsWith("@cloudflare/")
  );
}

/** The runtime composition may initialize schema, but cannot import policy implementations
 * or operate SQL. Check syntax nodes (including aliases/computed accesses), not SQL text. */
function checkCloudflareComposition(root, add) {
  const path = resolve(root, "apps/relay/src/computer-do.ts");
  if (!ts.sys.fileExists(path)) return;
  const file = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
  const imports = new Map([
    ["cloudflare:workers", new Set(["DurableObject"])],
    ["@shellbell/protocol", new Set(["randomBytes"])],
    [
      "@shellbell/relay-core",
      new Set([
        "createRelayCore",
        "createNotificationService",
        "RelayCore",
        "NotificationProvider",
        "createDirectNotificationProvider",
        "parseDirectPushCredentials",
        "QueueBudget",
        "InboundQueue",
        "frameLimitFor",
      ]),
    ],
    ["./adapters/identity-store.js", new Set(["createCloudflareIdentityStore"])],
    ["./adapters/notification-store.js", new Set(["createCloudflareNotificationStore"])],
    ["./adapters/push-diagnostics.js", new Set(["observePushDelivery"])],
    ["./adapters/transport.js", new Set(["createCloudflareTransport"])],
    ["./adapters/scheduler.js", new Set(["createCloudflareScheduler"])],
    [
      "./schema.js",
      new Set([
        "SCHEMA_SQL",
        "upgradePushContextSchema",
        "upgradeRevocationProofSchema",
        "upgradePairIdSchema",
      ]),
    ],
    ["./env.js", new Set(["Env"])],
  ]);
  const name = (node) =>
    ts.isIdentifier(node) || ts.isStringLiteralLike(node) ? node.text : undefined;
  const schema = new Set();
  const upgrades = new Set();
  for (const node of file.statements) {
    if (!ts.isImportDeclaration(node)) continue;
    const permitted = imports.get(name(node.moduleSpecifier));
    const bindings = node.importClause?.namedBindings;
    if (!permitted || node.importClause?.name || !bindings || !ts.isNamedImports(bindings)) {
      add(path, "composition-import", "only named runtime composition imports are allowed");
      continue;
    }
    for (const binding of bindings.elements) {
      const original = (binding.propertyName ?? binding.name).text;
      if (!permitted.has(original)) add(path, "composition-import", original);
      if (name(node.moduleSpecifier) === "./schema.js") {
        if (original === "SCHEMA_SQL") schema.add(binding.name.text);
        if (
          original === "upgradePushContextSchema" ||
          original === "upgradeRevocationProofSchema" ||
          original === "upgradePairIdSchema"
        )
          upgrades.add(binding.name.text);
      }
    }
  }
  function inConstructor(node) {
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (ts.isConstructorDeclaration(parent)) return true;
    }
    return false;
  }
  function walk(node) {
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword || name(node.expression) === "require")
    ) {
      add(path, "composition-import", "runtime module loading is not allowed");
    }
    const member = ts.isPropertyAccessExpression(node)
      ? node.name
      : ts.isElementAccessExpression(node)
        ? node.argumentExpression
        : undefined;
    if (member && name(member) === "sql") {
      const parent = node.parent;
      const call =
        ts.isPropertyAccessExpression(parent) && parent.name.text === "exec"
          ? parent.parent
          : parent;
      const initialization =
        ts.isCallExpression(call) &&
        inConstructor(node) &&
        ((call === parent &&
          upgrades.has(name(call.expression)) &&
          call.arguments.length === 1 &&
          call.arguments[0] === node) ||
          (call.expression === parent &&
            call.arguments.length === 1 &&
            schema.has(name(call.arguments[0]))));
      if (!initialization) add(path, "composition-storage", "SQL belongs in repository adapters");
    }
    if (ts.isBindingElement(node) && name(node.propertyName ?? node.name) === "sql") {
      add(path, "composition-storage", "SQL aliases belong in repository adapters");
    }
    ts.forEachChild(node, walk);
  }
  walk(file);
}

/** Node owns HTTP/process lifetime, not notification policy or direct SQL. */
function checkNodeComposition(root, add) {
  const path = resolve(root, "apps/relay-node/src/server.ts");
  if (!ts.sys.fileExists(path)) return;
  const file = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
  const imports = new Map([
    ["node:crypto", new Set(["randomBytes", "randomUUID"])],
    ["node:http", new Set(["createServer"])],
    ["node:net", new Set(["Socket"])],
    ["@shellbell/protocol", new Set(["FpSchema", "FRAME_LIMITS"])],
    [
      "@shellbell/relay-core",
      new Set([
        "createNotificationService",
        "createRelayCore",
        "frameLimitFor",
        "NotificationProvider",
        "QueueBudget",
        "RELAY_VERSION",
        "InboundQueue",
        "RelayCore",
        "createDirectNotificationProvider",
      ]),
    ],
    ["ws", new Set(["WebSocket", "WebSocketServer"])],
    ["./config.js", new Set(["RelayNodeConfig", "resolveConfig", "loadNodePushCredentials"])],
    ["./apns-transport.js", new Set(["createApnsHttp2Transport"])],
    ["./connection.js", new Set(["bindNodeConnection"])],
    ["./scheduler.js", new Set(["createNodeScheduler"])],
    ["./storage/database.js", new Set(["openRelayDatabase"])],
    ["./runtime-lifecycle.js", new Set(["RelayRuntimeLifecycle"])],
    ["./transport.js", new Set(["createNodeTransport"])],
  ]);
  function walk(node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier) {
        const permitted = ts.isStringLiteralLike(node.moduleSpecifier)
          ? imports.get(node.moduleSpecifier.text)
          : undefined;
        const bindings = ts.isImportDeclaration(node)
          ? node.importClause?.namedBindings
          : node.exportClause;
        if (
          !permitted ||
          (ts.isImportDeclaration(node) && node.importClause?.name) ||
          !bindings ||
          (!ts.isNamedImports(bindings) && !ts.isNamedExports(bindings))
        ) {
          add(path, "composition-import", "only named runtime composition imports are allowed");
        } else {
          for (const binding of bindings.elements) {
            const original = (binding.propertyName ?? binding.name).text;
            if (!permitted.has(original)) add(path, "composition-import", original);
          }
        }
      }
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      add(path, "composition-import", "runtime module loading is not allowed");
    } else if (ts.isImportEqualsDeclaration(node) || ts.isImportTypeNode(node)) {
      add(path, "composition-import", "use named runtime composition imports");
    }
    ts.forEachChild(node, walk);
  }
  walk(file);
}

/** Parse module references and follow TypeScript resolution, including paths and re-exports. */
export function checkRelayBoundaries(root) {
  root = realpathSync(root);
  const core = resolve(root, "packages/relay-core");
  const sourceRoot = realpathSync(resolve(core, "src"));
  const protocolRoot = realpathSync(resolve(root, "packages/protocol/src"));
  const findings = [];
  const add = (path, rule, detail) => findings.push({ path: relative(root, path), rule, detail });
  checkCloudflareComposition(root, add);
  checkNodeComposition(root, add);
  const configPath = resolve(core, "tsconfig.json");
  const config = ts.getParsedCommandLineOfConfigFile(
    configPath,
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: () =>
        add(configPath, "invalid-config", "cannot parse config"),
    },
  );
  if (!config || config.errors.length) {
    add(configPath, "invalid-config", "source config must resolve successfully");
    return findings;
  }
  if (!config.options.types || config.options.types.length) {
    add(configPath, "source-types", "source must explicitly set types: []");
  }
  if (
    config.options.strict !== true ||
    config.options.target !== ts.ScriptTarget.ES2022 ||
    config.options.lib?.length !== 2 ||
    !config.options.lib.includes("lib.es2022.d.ts") ||
    !config.options.lib.includes("lib.dom.d.ts")
  ) {
    add(configPath, "source-compiler", "source must use strict ES2022 and DOM only");
  }

  const visited = new Set();
  const cache = ts.createModuleResolutionCache(core, (path) => path, config.options);
  function visit(path) {
    const actual = realpathSync(path);
    if (visited.has(actual)) return;
    visited.add(actual);
    if (!within(actual, sourceRoot) && !within(actual, protocolRoot)) {
      add(path, "outside-core", `source resolves to ${relative(root, actual)}`);
      return;
    }
    const file = ts.createSourceFile(
      actual,
      readFileSync(actual, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    if (file.parseDiagnostics.length) add(actual, "invalid-source", "cannot parse module");
    for (const directive of [
      ...file.typeReferenceDirectives,
      ...file.referencedFiles,
      ...file.libReferenceDirectives,
    ]) {
      add(actual, "ambient-reference", directive.fileName);
    }
    function reference(specifier) {
      if (forbidden(specifier)) {
        add(actual, "forbidden-import", specifier);
        return;
      }
      const resolved = ts.resolveModuleName(
        specifier,
        actual,
        config.options,
        ts.sys,
        cache,
      ).resolvedModule;
      if (!resolved) {
        add(
          actual,
          specifier.startsWith(".") ? "unresolved-import" : "forbidden-import",
          specifier,
        );
        return;
      }
      const target = realpathSync(resolved.resolvedFileName);
      if (target.split(sep).includes("test-support")) {
        add(actual, "test-support", specifier);
      } else if (
        actual === resolve(sourceRoot, "version.ts") &&
        specifier === "../package.json" &&
        target === realpathSync(resolve(core, "package.json"))
      ) {
        // Own release metadata is inert data, not a runtime or policy dependency.
      } else if (within(target, sourceRoot) || within(target, protocolRoot)) {
        if (!target.endsWith(".json")) visit(target);
      } else if (
        resolved.isExternalLibraryImport &&
        target.split(sep).includes("node_modules") &&
        approvedPackages.has(packageName(specifier))
      ) {
        // Approved external packages are trusted browser dependencies, not adapter entrypoints.
        const owner = resolvedPackageOwner(target);
        if (
          !approvedPackages.has(owner) ||
          (resolved.packageId && resolved.packageId.name !== owner)
        ) {
          add(
            actual,
            "forbidden-import",
            `${specifier} resolves to ${owner ?? "unknown package owner"}`,
          );
        }
      } else {
        add(actual, "outside-core", `${specifier} resolves to ${relative(root, target)}`);
      }
    }
    function moduleExpression(expression) {
      if (expression && ts.isStringLiteralLike(expression)) reference(expression.text);
      else add(actual, "computed-import", "module specifier must be a literal");
    }
    function walk(node) {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        if (node.moduleSpecifier) moduleExpression(node.moduleSpecifier);
      } else if (
        ts.isImportEqualsDeclaration(node) &&
        ts.isExternalModuleReference(node.moduleReference)
      ) {
        moduleExpression(node.moduleReference.expression);
      } else if (ts.isImportTypeNode(node)) {
        moduleExpression(ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined);
      } else if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === "require"))
      ) {
        moduleExpression(node.arguments[0]);
      }
      ts.forEachChild(node, walk);
    }
    walk(file);
  }
  for (const file of ts.sys.readDirectory(sourceRoot, sourceExtensions)) visit(file);

  const manifestPath = resolve(core, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  function exportTargets(value) {
    if (typeof value === "string") {
      const target = resolve(core, value);
      if (!value.startsWith("./") || !within(target, sourceRoot)) {
        add(manifestPath, "production-export", value);
      } else if (!value.includes("*")) {
        if (!ts.sys.fileExists(target)) add(manifestPath, "production-export", `missing ${value}`);
        else {
          const actual = realpathSync(target);
          if (!within(actual, sourceRoot)) add(manifestPath, "production-export", value);
          else visit(actual);
        }
      }
    } else if (Array.isArray(value)) {
      for (const item of value) exportTargets(item);
    } else if (value && typeof value === "object") {
      for (const [key, target] of Object.entries(value)) {
        if (key.includes("test-support")) add(manifestPath, "production-export", key);
        exportTargets(target);
      }
    }
  }
  for (const field of [
    "exports",
    "main",
    "module",
    "types",
    "typings",
    "browser",
    "typesVersions",
  ]) {
    exportTargets(manifest[field]);
  }
  return findings;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const root = resolve(process.argv[2] ?? resolve(dirname(fileURLToPath(import.meta.url)), ".."));
    const findings = checkRelayBoundaries(root);
    for (const finding of findings) {
      console.error(`${finding.path}: ${finding.rule}: ${finding.detail}`);
    }
    console.log(`Relay boundary check: ${findings.length} findings.`);
    process.exitCode = findings.length ? 1 : 0;
  } catch (error) {
    console.error(`Relay boundary check: could not complete (${error.message}).`);
    process.exitCode = 2;
  }
}
