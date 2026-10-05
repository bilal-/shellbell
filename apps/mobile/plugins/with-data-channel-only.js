const { withAndroidManifest } = require("expo/config-plugins");

const MEDIA_PROJECTION_SERVICE = "com.oney.WebRTCModule.MediaProjectionService";

/** WebRTC data channels do not need the library's screen-capture foreground service. */
function removeUnusedMediaProjectionService(document) {
  const manifest = document.manifest;
  const application = manifest.application?.[0];
  if (!application) throw new Error("Android manifest has no application");
  manifest.$ = { ...manifest.$, "xmlns:tools": "http://schemas.android.com/tools" };
  application.service ??= [];
  application.service = application.service.filter(
    (service) => service.$?.["android:name"] !== MEDIA_PROJECTION_SERVICE,
  );
  application.service.push({
    $: { "android:name": MEDIA_PROJECTION_SERVICE, "tools:node": "remove" },
  });
  return document;
}

function withDataChannelOnly(config) {
  return withAndroidManifest(config, (mod) => {
    mod.modResults = removeUnusedMediaProjectionService(mod.modResults);
    return mod;
  });
}

module.exports = withDataChannelOnly;
module.exports.removeUnusedMediaProjectionService = removeUnusedMediaProjectionService;
