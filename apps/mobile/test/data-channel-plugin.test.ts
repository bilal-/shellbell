import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { removeUnusedMediaProjectionService } = require("../plugins/with-data-channel-only.js");

describe("data-channel-only Android manifest", () => {
  it("removes WebRTC's unused screen-capture service without changing other services", () => {
    const document = {
      manifest: {
        $: { "xmlns:android": "http://schemas.android.com/apk/res/android" },
        application: [
          {
            service: [
              { $: { "android:name": "dev.shellbell.notifications.ShellbellMessagingService" } },
            ],
          },
        ],
      },
    };
    removeUnusedMediaProjectionService(document);
    removeUnusedMediaProjectionService(document);
    expect((document.manifest.$ as Record<string, string>)["xmlns:tools"]).toBe(
      "http://schemas.android.com/tools",
    );
    expect(document.manifest.application[0]?.service).toEqual([
      { $: { "android:name": "dev.shellbell.notifications.ShellbellMessagingService" } },
      {
        $: {
          "android:name": "com.oney.WebRTCModule.MediaProjectionService",
          "tools:node": "remove",
        },
      },
    ]);
  });
});
