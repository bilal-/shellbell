const { AndroidConfig, withAndroidManifest, withAppBuildGradle } = require("expo/config-plugins");

/**
 * Pairing scans QR codes with ML Kit, which Expo Camera bundles with its own barcode model:
 * about 5 MB of native code for every Android architecture. Google Play services provides the
 * same model, downloaded once with the app, so the app uses that instead. The API is the same.
 */
const BUNDLED = "com.google.mlkit:barcode-scanning";
const THIN = "com.google.android.gms:play-services-mlkit-barcode-scanning:18.3.1";
const MARKER = "// Shellbell: barcode model from Google Play services";
const DEPENDENCIES = "com.google.mlkit.vision.DEPENDENCIES";
const MODELS = "barcode_ui,barcode";

function thinBarcodeGradle(contents) {
  if (contents.includes(MARKER)) return contents;
  return `${contents.trimEnd()}

${MARKER}
configurations.all {
    resolutionStrategy.dependencySubstitution {
        substitute module("${BUNDLED}") using module("${THIN}")
    }
}
`;
}

function withThinBarcode(config) {
  config = withAppBuildGradle(config, (mod) => {
    if (mod.modResults.language !== "groovy")
      throw new Error("The barcode model substitution requires Groovy Gradle");
    mod.modResults.contents = thinBarcodeGradle(mod.modResults.contents);
    return mod;
  });
  return withAndroidManifest(config, (mod) => {
    mod.modResults = thinBarcodeManifest(mod.modResults);
    return mod;
  });
}

/**
 * Asks Play services to fetch the model when the app installs, so the first scan needn't wait.
 * Expo Camera already asks for `barcode_ui`; the merged list keeps it.
 */
function thinBarcodeManifest(manifest) {
  manifest.manifest.$["xmlns:tools"] ??= "http://schemas.android.com/tools";
  const application = AndroidConfig.Manifest.getMainApplicationOrThrow(manifest);
  const items = (application["meta-data"] ??= []);
  const item = items.find((entry) => entry.$["android:name"] === DEPENDENCIES);
  const value = {
    "android:name": DEPENDENCIES,
    "android:value": MODELS,
    "tools:replace": "android:value",
  };
  if (item) item.$ = value;
  else items.push({ $: value });
  return manifest;
}

module.exports = withThinBarcode;
module.exports.thinBarcodeGradle = thinBarcodeGradle;
module.exports.thinBarcodeManifest = thinBarcodeManifest;
