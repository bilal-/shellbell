const { mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { withAndroidManifest, withDangerousMod, withInfoPlist } = require("expo/config-plugins");

/**
 * The page view reaches the phone's own web door at http://127.0.0.1:<port>. Release builds refuse
 * plain HTTP, so this allows it for that one address and nothing else. Debug builds keep plain HTTP
 * everywhere, for Metro; the debug resource overrides the main one by build type.
 */
const RELEASE = `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <base-config cleartextTrafficPermitted="false" />
    <domain-config cleartextTrafficPermitted="true">
        <domain includeSubdomains="false">127.0.0.1</domain>
    </domain-config>
</network-security-config>
`;
const DEBUG = `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <base-config cleartextTrafficPermitted="true" />
</network-security-config>
`;
const NAME = "network_security_config";

function loopbackCleartextManifest(document) {
  const application = document.manifest.application?.[0];
  if (!application) throw new Error("Android manifest has no application");
  application.$ = { ...application.$, "android:networkSecurityConfig": `@xml/${NAME}` };
  return document;
}

function writeConfigs(root) {
  for (const [set, contents] of [
    ["main", RELEASE],
    ["debug", DEBUG],
    ["debugOptimized", DEBUG],
  ]) {
    const dir = join(root, "app", "src", set, "res", "xml");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${NAME}.xml`), contents);
  }
}

function withLoopbackCleartext(config) {
  config = withInfoPlist(config, (mod) => {
    mod.modResults = loopbackCleartextInfoPlist(mod.modResults);
    return mod;
  });
  config = withAndroidManifest(config, (mod) => {
    mod.modResults = loopbackCleartextManifest(mod.modResults);
    return mod;
  });
  return withDangerousMod(config, [
    "android",
    (mod) => {
      writeConfigs(mod.modRequest.platformProjectRoot);
      return mod;
    },
  ]);
}

module.exports = withLoopbackCleartext;
module.exports.loopbackCleartextManifest = loopbackCleartextManifest;
module.exports.writeConfigs = writeConfigs;
module.exports.RELEASE = RELEASE;
module.exports.loopbackCleartextInfoPlist = loopbackCleartextInfoPlist;

function loopbackCleartextInfoPlist(plist) {
  return {
    ...plist,
    NSAppTransportSecurity: {
      ...plist.NSAppTransportSecurity,
      NSAllowsLocalNetworking: true,
    },
  };
}
