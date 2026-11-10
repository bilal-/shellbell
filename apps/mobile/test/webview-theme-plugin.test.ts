import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { darkWebViewTheme } = require("../plugins/with-webview-theme.js");

describe("WebView color preference", () => {
  it("exposes Shellbell's dark theme without changing page colors or other native themes", () => {
    const styles = {
      resources: {
        style: [
          {
            $: { name: "AppTheme", parent: "Theme.AppCompat.DayNight.NoActionBar" },
            item: [
              { $: { name: "android:windowBackground" }, _: "@color/activityBackground" },
              { $: { name: "android:isLightTheme" }, _: "true" },
            ],
          },
          { $: { name: "OtherTheme" }, item: [{ $: { name: "android:isLightTheme" }, _: "true" }] },
        ],
      },
    };
    darkWebViewTheme(styles);
    darkWebViewTheme(styles);
    expect(styles.resources.style[0]?.item).toEqual([
      { $: { name: "android:windowBackground" }, _: "@color/activityBackground" },
      { $: { name: "android:isLightTheme" }, _: "false" },
    ]);
    expect(styles.resources.style[1]?.item).toEqual([
      { $: { name: "android:isLightTheme" }, _: "true" },
    ]);
  });

  it("fails native generation if the expected application theme is missing", () => {
    expect(() => darkWebViewTheme({ resources: {} })).toThrow("requires AppTheme");
  });
});
