const { withAppBuildGradle, withGradleProperties } = require("expo/config-plugins");

const RELEASE_PROPERTIES = [
  "android.enableMinifyInReleaseBuilds",
  "android.enableShrinkResourcesInReleaseBuilds",
  "android.r8.optimizedResourceShrinking",
];

function enableReleaseProperties(properties) {
  return [
    ...properties.filter((item) => !RELEASE_PROPERTIES.includes(item.key)),
    ...RELEASE_PROPERTIES.map((key) => ({ type: "property", key, value: "true" })),
  ];
}

function optimizeReleaseGradle(contents) {
  for (const key of RELEASE_PROPERTIES.slice(0, 2)) {
    if (!contents.includes(`findProperty('${key}')`))
      throw new Error(`Android release template no longer uses ${key}`);
  }
  const defaults = /getDefaultProguardFile\((["'])proguard-android(?:-optimize)?\.txt\1\)/g;
  if (!defaults.test(contents))
    throw new Error("Android release template has no default ProGuard configuration");
  return contents.replace(defaults, 'getDefaultProguardFile("proguard-android-optimize.txt")');
}

function withReleaseOptimization(config) {
  config = withGradleProperties(config, (mod) => {
    mod.modResults = enableReleaseProperties(mod.modResults);
    return mod;
  });
  return withAppBuildGradle(config, (mod) => {
    if (mod.modResults.language !== "groovy")
      throw new Error("Android release optimization requires Groovy Gradle");
    mod.modResults.contents = optimizeReleaseGradle(mod.modResults.contents);
    return mod;
  });
}

module.exports = withReleaseOptimization;
module.exports.enableReleaseProperties = enableReleaseProperties;
module.exports.optimizeReleaseGradle = optimizeReleaseGradle;
