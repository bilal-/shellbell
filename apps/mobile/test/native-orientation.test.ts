import { AndroidConfig, IOSConfig } from "@expo/config-plugins";
import type { ExpoConfig } from "@expo/config-types";
import { describe, expect, it } from "vitest";
import app from "../app.json";

describe("native orientation generated from the app configuration", () => {
  const config = app.expo as ExpoConfig;
  it("allows portrait and both landscape orientations on iOS", () => {
    const plist = IOSConfig.Orientation.setOrientation(config, {});
    expect(plist.UISupportedInterfaceOrientations).toEqual(
      expect.arrayContaining([
        "UIInterfaceOrientationPortrait",
        "UIInterfaceOrientationLandscapeLeft",
        "UIInterfaceOrientationLandscapeRight",
      ]),
    );
  });
  it("leaves Android activity orientation to the system policy", () => {
    const manifest: AndroidConfig.Manifest.AndroidManifest = {
      manifest: {
        queries: [],
        $: { "xmlns:android": "http://schemas.android.com/apk/res/android" },
        application: [
          {
            $: { "android:name": ".MainApplication" },
            activity: [{ $: { "android:name": ".MainActivity" } }],
          },
        ],
      },
    };
    const output = AndroidConfig.Orientation.setAndroidOrientation(config, manifest);
    expect(output.manifest.application?.[0]?.activity?.[0]?.$["android:screenOrientation"]).toBe(
      "unspecified",
    );
  });
});
