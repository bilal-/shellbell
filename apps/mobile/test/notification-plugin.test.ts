import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  configureAndroidManifest,
  addNotificationExtension,
  notificationEntitlements,
  notificationExtensionInfo,
} = require("../plugins/with-shellbell-notifications.js");
const xcode = require("xcode");
const plist = require("@expo/plist").default;
const bundle = "sh.bilal.shellbell";

it("emits the notification extension bundle name required by App Store validation", () => {
  const info = plist.parse(plist.build(notificationExtensionInfo(bundle)));
  // CFBundleDisplayName does not satisfy Apple's required CFBundleName field.
  expect(info.CFBundleName).toBe("$(PRODUCT_NAME)");
});

function projectFixture() {
  const p = xcode.project("unused.pbxproj");
  p.hash = {
    project: {
      rootObject: "AAAAAAAAAAAAAAAAAAAAAAAA",
      objects: {
        PBXProject: {
          AAAAAAAAAAAAAAAAAAAAAAAA: {
            isa: "PBXProject",
            mainGroup: "BBBBBBBBBBBBBBBBBBBBBBBB",
            targets: [{ value: "CCCCCCCCCCCCCCCCCCCCCCCC", comment: "Shellbell" }],
            attributes: {},
          },
        },
        PBXNativeTarget: {
          CCCCCCCCCCCCCCCCCCCCCCCC: {
            isa: "PBXNativeTarget",
            name: "Shellbell",
            productType: '"com.apple.product-type.application"',
            buildPhases: [],
            dependencies: [],
          },
        },
        PBXGroup: {
          BBBBBBBBBBBBBBBBBBBBBBBB: { isa: "PBXGroup", children: [], sourceTree: '"<group>"' },
        },
        PBXBuildFile: {},
        PBXFileReference: {},
        XCBuildConfiguration: {},
        XCConfigurationList: {},
      },
    },
  };
  return p;
}

describe("reproducible native notification wiring", () => {
  it("copies host release versions into the extension and includes every native core source", () => {
    const project = projectFixture();
    // Expo's generated host Info.plist uses config.version while its unused
    // MARKETING_VERSION build setting may still contain the template's 1.0.
    project.pbxNativeTargetSection().CCCCCCCCCCCCCCCCCCCCCCCC.buildConfigurationList = "host";
    project.pbxXCConfigurationList().host = { buildConfigurations: [{ value: "hostDebug" }] };
    project.pbxXCBuildConfigurationSection().hostDebug = {
      name: "Debug",
      buildSettings: { MARKETING_VERSION: "1.0", CURRENT_PROJECT_VERSION: "1" },
    };
    addNotificationExtension(project, bundle, { version: "2.3.4", buildNumber: "42" });
    const configs = Object.values(project.pbxXCBuildConfigurationSection()) as {
      buildSettings?: Record<string, string>;
    }[];
    const builds = configs.filter(
      (c) => c.buildSettings?.PRODUCT_BUNDLE_IDENTIFIER === `"${bundle}.notifications"`,
    );
    expect(builds).toHaveLength(2);
    for (const build of builds) {
      expect(build.buildSettings?.CURRENT_PROJECT_VERSION).toBe("42");
      expect(build.buildSettings?.MARKETING_VERSION).toBe("2.3.4");
      expect(build.buildSettings?.PRODUCT_MODULE_NAME).toBe("ShellbellNotificationService");
    }
    const serialized = project.writeSync();
    for (const source of [
      "NotificationCrypto.swift",
      "NotificationStore.swift",
      "NotificationPolicy.swift",
      "NotificationKeychainVault.swift",
      "NotificationStoreFactory.swift",
      "NotificationPresentation.swift",
      "NotificationService.swift",
    ]) {
      expect(serialized).toContain(source);
    }
  });
  it("replaces only Expo's messaging receiver and does not duplicate the owner", () => {
    const manifest = {
      manifest: { application: [{ service: [{ $: { "android:name": "unrelated.Service" } }] }] },
    };
    configureAndroidManifest(manifest);
    configureAndroidManifest(manifest);
    const services = manifest.manifest.application[0]!.service;
    expect(
      services.filter(
        (s) => s.$["android:name"] === "dev.shellbell.notifications.ShellbellMessagingService",
      ),
    ).toHaveLength(1);
    expect(
      services.find(
        (s) =>
          s.$["android:name"] === "expo.modules.notifications.service.ExpoFirebaseMessagingService",
      ),
    ).toMatchObject({ $: { "tools:node": "remove" } });
    expect(services.find((s) => s.$["android:name"] === "unrelated.Service")).toBeDefined();
  });

  it("adds exactly one embedded extension and retains host keychain access", () => {
    const project = projectFixture();
    addNotificationExtension(project, bundle);
    addNotificationExtension(project, bundle);
    const targets = Object.values(project.pbxNativeTargetSection()) as { productType?: string }[];
    expect(
      targets.filter((t) => t.productType === '"com.apple.product-type.app-extension"'),
    ).toHaveLength(1);
    const configs = Object.values(project.pbxXCBuildConfigurationSection()) as {
      buildSettings?: Record<string, string>;
    }[];
    const builds = configs.filter(
      (c) => c.buildSettings?.PRODUCT_BUNDLE_IDENTIFIER === `"${bundle}.notifications"`,
    );
    expect(builds).toHaveLength(2);
    expect(builds.every((c) => c.buildSettings?.APPLICATION_EXTENSION_API_ONLY === "YES")).toBe(
      true,
    );
    const entitlements = notificationEntitlements(bundle, {
      "keychain-access-groups": ["existing.group"],
    });
    expect(entitlements["keychain-access-groups"]).toEqual(
      expect.arrayContaining([
        "existing.group",
        `$(AppIdentifierPrefix)${bundle}`,
        `$(AppIdentifierPrefix)${bundle}.notifications`,
      ]),
    );
    expect(notificationEntitlements(bundle, entitlements)).toEqual(entitlements);
  });
});
