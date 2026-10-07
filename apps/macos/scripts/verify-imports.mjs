// Static linker only: never imports/requires/evaluates any packaged module.
// Run with --experimental-import-meta-resolve to enable the explicit parent URL.
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { builtinModules, createRequire } from "node:module";
import { dirname, extname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { admitNativeLoader } from "./native-loader-policy.mjs";
import { admitTerminalPluginLoader } from "./terminal-plugin-loader-policy.mjs";

const agent = realpathSync(process.argv[2]);
const seen = new Set();
const optional = new Set();
let bytes = 0;
function refuse(message) {
  throw new Error(`import-closure: ${message}`);
}
function inside(path) {
  const actual = realpathSync(path),
    rel = relative(agent, actual);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`))
    refuse(`escaping target ${path}`);
  const st = lstatSync(actual);
  if (!st.isFile() || (st.mode & 0o7022) !== 0) refuse(`unsafe target ${path}`);
  return actual;
}
function packageScope(file) {
  for (let dir = dirname(file); dir.startsWith(agent); dir = dirname(dir)) {
    const path = join(dir, "package.json");
    if (existsSync(path)) {
      inside(path);
      return JSON.parse(readFileSync(path, "utf8"));
    }
    if (dir === agent) break;
  }
  return {};
}
function literal(node) {
  return node && ts.isStringLiteralLike(node) ? node.text : null;
}
function importSpecifier(node) {
  const direct = literal(node);
  if (direct !== null) return direct;
  // The service entry uses import(new URL(`./cli.js`, import.meta.url).href).
  if (node && ts.isPropertyAccessExpression(node) && node.name.text === "href") {
    const ctor = node.expression;
    if (
      ts.isNewExpression(ctor) &&
      ts.isIdentifier(ctor.expression) &&
      ctor.expression.text === "URL" &&
      ctor.arguments?.length === 2
    ) {
      const base = ctor.arguments[1];
      if (
        ts.isPropertyAccessExpression(base) &&
        base.name.text === "url" &&
        ts.isMetaProperty(base.expression) &&
        base.expression.keywordToken === ts.SyntaxKind.ImportKeyword
      )
        return literal(ctor.arguments[0]);
    }
  }
  refuse("unsupported computed module specifier");
}
function guarded(node) {
  for (let child = node, parent = node.parent; parent; child = parent, parent = parent.parent) {
    if (ts.isTryStatement(parent) && parent.tryBlock === child && parent.catchClause)
      return parent.catchClause.block.statements.length === 0;
    // A try around a function definition cannot catch a later call of that function.
    if (ts.isFunctionLike(parent)) return false;
  }
  return false;
}
function missingOptional(file, specifier, node, error) {
  if (error.code !== "MODULE_NOT_FOUND" || !guarded(node)) return false;
  const pkg = packageScope(file);
  if (
    pkg.peerDependenciesMeta?.[specifier]?.optional !== true ||
    !Object.hasOwn(pkg.peerDependencies ?? {}, specifier)
  )
    return false;
  const paths = createRequire(file).resolve.paths(specifier) ?? [];
  // Only a wholly absent optional package is exempt. A broken installed package is not.
  if (paths.some((base) => base.startsWith(`${agent}${sep}`) && existsSync(join(base, specifier))))
    return false;
  optional.add(`${pkg.name}: ${specifier}`);
  return true;
}
function follow(file, specifier, mode, node) {
  if (specifier.startsWith("node:") || builtinModules.includes(specifier)) return;
  if (
    isAbsolute(specifier) ||
    specifier.startsWith("file:") ||
    /^[a-zA-Z][\w+.-]*:/.test(specifier)
  )
    refuse("unsupported absolute/URL import");
  let target;
  try {
    if (mode === "import") {
      const url = new URL(import.meta.resolve(specifier, pathToFileURL(file).href));
      if (url.protocol !== "file:" || url.search || url.hash)
        refuse("unsupported resolved import URL");
      target = fileURLToPath(url);
    } else target = createRequire(file).resolve(specifier);
  } catch (error) {
    if (mode === "require" && missingOptional(file, specifier, node, error)) return;
    throw error;
  }
  target = inside(target);
  const dist = join(agent, "dist");
  if (
    file.startsWith(`${dist}${sep}`) &&
    specifier.startsWith(".") &&
    !target.startsWith(`${dist}${sep}`)
  )
    refuse("generated relative import escapes dist");
  scan(target);
}
function scan(file) {
  file = inside(file);
  if (seen.has(file)) return;
  seen.add(file);
  if (seen.size > 10000) refuse("module count exceeded");
  const text = readFileSync(file, "utf8");
  bytes += Buffer.byteLength(text);
  if (bytes > 100000000) refuse("source byte limit exceeded");
  if (admitTerminalPluginLoader(agent, file, text)) return;
  if (
    admitNativeLoader(file, text, process.argv[3] ?? process.arch, inside, follow, process.argv[4])
  )
    return;
  const extension = extname(file);
  if (extension === ".json") {
    JSON.parse(text);
    return;
  }
  if (![".js", ".mjs", ".cjs"].includes(extension)) refuse(`unsupported module type ${extension}`);
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  // TypeScript diagnoses legacy string escapes even in legal sloppy CommonJS.
  // This exception changes no import expression: those are still traversed below.
  const sloppyCommonJS =
    (extension === ".cjs" || (extension === ".js" && packageScope(file).type !== "module")) &&
    !source.statements.some(
      (statement) =>
        ts.isExpressionStatement(statement) && literal(statement.expression) === "use strict",
    );
  if (source.parseDiagnostics.some((diagnostic) => diagnostic.code !== 1487 || !sloppyCommonJS))
    refuse(`invalid JavaScript ${file}`);
  const factoryBindings = [];
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !["node:module", "module"].includes(literal(statement.moduleSpecifier))
    )
      continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings))
      for (const item of bindings.elements)
        if ((item.propertyName ?? item.name).text === "createRequire")
          factoryBindings.push(item.name);
  }
  // Bundler minification reuses short names in unrelated lexical scopes. Bind
  // symbols without resolving or executing modules; identifier text is not
  // enough to distinguish a loader from a parameter/property of the same name.
  let checker;
  if (factoryBindings.length) {
    const options = { allowJs: true, noLib: true, noResolve: true };
    const host = ts.createCompilerHost(options);
    host.getSourceFile = (name) => (name === file ? source : undefined);
    host.readFile = () => undefined;
    host.fileExists = (name) => name === file;
    checker = ts.createProgram([file], options, host).getTypeChecker();
  }
  const symbol = (node) => {
    if (ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node)
      return checker?.getShorthandAssignmentValueSymbol(node.parent);
    if (ts.isExportSpecifier(node.parent))
      return checker?.getExportSpecifierLocalTargetSymbol(node.parent);
    return checker?.getSymbolAtLocation(node);
  };
  const factories = new Set(factoryBindings.map(symbol));
  if (factories.has(undefined)) refuse("unresolved createRequire binding");
  function resolverOnly(call) {
    const binding = call.parent;
    if (
      !ts.isVariableDeclaration(binding) ||
      binding.initializer !== call ||
      !ts.isIdentifier(binding.name)
    )
      refuse("unsupported dynamic require loader");
    const resolver = symbol(binding.name);
    if (!resolver) refuse("unresolved require resolver binding");
    let scope = binding.parent;
    while (scope.parent && !ts.isFunctionLike(scope)) scope = scope.parent;
    function check(node) {
      if (ts.isIdentifier(node) && symbol(node) === resolver && node !== binding.name) {
        const parent = node.parent;
        if (
          !ts.isPropertyAccessExpression(parent) ||
          parent.expression !== node ||
          parent.name.text !== "resolve" ||
          !ts.isCallExpression(parent.parent) ||
          parent.parent.expression !== parent
        )
          refuse("unsupported dynamic require invocation");
      }
      ts.forEachChild(node, check);
    }
    check(scope);
  }
  function visit(node) {
    if (ts.isIdentifier(node) && factories.size && factories.has(symbol(node))) {
      if (ts.isCallExpression(node.parent) && node.parent.expression === node)
        resolverOnly(node.parent);
      else if (!ts.isImportSpecifier(node.parent)) refuse("unsupported createRequire alias");
    }
    if (ts.isPropertyAccessExpression(node) && node.name.text === "createRequire")
      refuse("unsupported createRequire access");
    if (ts.isIdentifier(node) && node.text === "require") {
      const parent = node.parent;
      const direct = ts.isCallExpression(parent) && parent.expression === node;
      const resolveCall =
        ts.isPropertyAccessExpression(parent) &&
        parent.expression === node &&
        parent.name.text === "resolve" &&
        ts.isCallExpression(parent.parent) &&
        parent.parent.expression === parent;
      const moduleRequire =
        ts.isPropertyAccessExpression(parent) &&
        parent.name === node &&
        ts.isIdentifier(parent.expression) &&
        parent.expression.text === "module" &&
        ts.isCallExpression(parent.parent) &&
        parent.parent.expression === parent;
      if (!direct && !resolveCall && !moduleRequire && !ts.isTypeOfExpression(parent))
        refuse("unsupported require alias");
    }
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier)
      follow(file, importSpecifier(node.moduleSpecifier), "import", node);
    if (ts.isCallExpression(node)) {
      const expr = node.expression;
      if (expr.kind === ts.SyntaxKind.ImportKeyword)
        follow(file, importSpecifier(node.arguments[0]), "import", node);
      else if (
        (ts.isIdentifier(expr) && expr.text === "require") ||
        (ts.isPropertyAccessExpression(expr) &&
          ts.isIdentifier(expr.expression) &&
          ((expr.expression.text === "module" && expr.name.text === "require") ||
            (expr.expression.text === "require" && expr.name.text === "resolve")))
      ) {
        const specifier = literal(node.arguments[0]);
        if (specifier === null) refuse("unsupported computed require");
        follow(file, specifier, "require", node);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}
try {
  const dist = join(agent, "dist");
  for (const name of readdirSync(dist)) if (/\.[mc]?js$/.test(name)) scan(join(dist, name));
  console.log(
    JSON.stringify({ modules: seen.size, bytes, absentOptionalPackages: [...optional].sort() }),
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
