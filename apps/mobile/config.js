const { readFileSync } = require("node:fs");

const { version: APP_VERSION } = require("./package.json");

const APP_ID = "sh.bilal.shellbell";
/**
 * @param {Partial<import('expo/config').ExpoConfig>} base
 * @param {Record<string, string | undefined>} env
 * @returns {import('expo/config').ExpoConfig}
 */
function mobileConfig(base, env) {
  const googleServicesFile = env.SHELLBELL_GOOGLE_SERVICES_FILE;
  if (googleServicesFile) {
    const json = JSON.parse(readFileSync(googleServicesFile, "utf8"));
    if (
      !Array.isArray(json.client) ||
      !json.client.some(
        (client) => client.client_info?.android_client_info?.package_name === APP_ID,
      )
    ) {
      throw new Error("Firebase client must match the Android application ID");
    }
  }
  const { owner: _owner, extra: _extra, ...publicBase } = base;
  const buildNumber = env.SHELLBELL_BUILD_NUMBER;
  if (buildNumber && (!/^[1-9][0-9]*$/.test(buildNumber) || Number(buildNumber) > 2100000000)) {
    throw new Error("Invalid local build number");
  }
  return {
    ...publicBase,
    version: APP_VERSION,
    name: "Shellbell",
    slug: "shellbell",
    ios: {
      ...base.ios,
      bundleIdentifier: APP_ID,
      appleTeamId: env.SHELLBELL_APPLE_TEAM_ID,
      ...(buildNumber ? { buildNumber } : {}),
    },
    android: {
      ...base.android,
      package: APP_ID,
      googleServicesFile,
      ...(buildNumber ? { versionCode: Number(buildNumber) } : {}),
    },
    extra: {},
  };
}
module.exports = { mobileConfig };
