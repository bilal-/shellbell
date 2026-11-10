const { withAndroidStyles } = require("expo/config-plugins");

// Shellbell currently uses a dark interface. WebView reads its context's native
// theme, which can differ from the activity's AppCompat night-mode override.
// Advertise the same preference through prefers-color-scheme; pages still own
// their colors, and pages without a dark theme are not algorithmically darkened.
function darkWebViewTheme(styles) {
  const theme = styles.resources.style?.find((style) => style.$?.name === "AppTheme");
  if (!theme) throw new Error("Shellbell WebView theme requires AppTheme");
  const name = "android:isLightTheme";
  theme.item = (theme.item ?? []).filter((item) => item.$?.name !== name);
  theme.item.push({ $: { name }, _: "false" });
  return styles;
}

function withWebViewTheme(config) {
  return withAndroidStyles(config, (mod) => {
    mod.modResults = darkWebViewTheme(mod.modResults);
    return mod;
  });
}

module.exports = withWebViewTheme;
module.exports.darkWebViewTheme = darkWebViewTheme;
