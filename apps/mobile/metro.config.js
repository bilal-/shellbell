const { getDefaultConfig } = require("expo/metro-config");
const fs = require("node:fs");
const path = require("node:path");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");
const protocolSrc = path.resolve(workspaceRoot, "packages/protocol/src");

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];

const upstream = config.resolver.resolveRequest;
const fallback = (context, moduleName, platform) =>
  upstream
    ? upstream(context, moduleName, platform)
    : context.resolveRequest(context, moduleName, platform);

config.resolver.resolveRequest = (context, moduleName, platform) => {
  // The package root: pin it to the TypeScript entry so Metro never guesses.
  if (moduleName === "@shellbell/protocol") {
    return { type: "sourceFile", filePath: path.join(protocolSrc, "index.ts") };
  }
  // Relative ".js" specifiers written inside packages/protocol/src resolve to their ".ts" source.
  const origin = context.originModulePath ?? "";
  const insideProtocol = origin.startsWith(protocolSrc + path.sep);
  if (insideProtocol && moduleName.startsWith(".") && moduleName.endsWith(".js")) {
    const candidate = path.resolve(path.dirname(origin), `${moduleName.slice(0, -3)}.ts`);
    if (fs.existsSync(candidate)) {
      return { type: "sourceFile", filePath: candidate };
    }
  }
  return fallback(context, moduleName, platform);
};

module.exports = config;
