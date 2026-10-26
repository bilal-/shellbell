import { createRequire } from "node:module";
import { expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { thinBarcodeGradle, thinBarcodeManifest } = require("../plugins/with-thin-barcode.js");

it("swaps the bundled barcode model for Play services' copy once", () => {
  const gradle = "android {\n}\n";
  const thin = thinBarcodeGradle(gradle);
  expect(thin).toContain(
    'substitute module("com.google.mlkit:barcode-scanning") using module("com.google.android.gms:play-services-mlkit-barcode-scanning:18.3.1")',
  );
  expect(thin.startsWith(gradle.trimEnd())).toBe(true);
  expect(thinBarcodeGradle(thin)).toBe(thin);
});

it("asks Play services for the model at install, keeping Expo Camera's request", () => {
  const manifest = {
    manifest: {
      $: { "xmlns:android": "http://schemas.android.com/apk/res/android" },
      application: [{ $: { "android:name": ".MainApplication" }, "meta-data": [] }],
    },
  };
  const item = (m: typeof manifest) =>
    (m.manifest.application[0]!["meta-data"] as { $: Record<string, string> }[])[0]!.$;
  thinBarcodeManifest(manifest);
  thinBarcodeManifest(manifest);
  expect(manifest.manifest.application[0]!["meta-data"]).toHaveLength(1);
  expect(item(manifest)).toEqual({
    "android:name": "com.google.mlkit.vision.DEPENDENCIES",
    "android:value": "barcode_ui,barcode",
    "tools:replace": "android:value",
  });
  expect(manifest.manifest.$).toMatchObject({ "xmlns:tools": "http://schemas.android.com/tools" });
});
