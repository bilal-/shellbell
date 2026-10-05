const {
  withAndroidManifest,
  withEntitlementsPlist,
  withXcodeProject,
  withDangerousMod,
  withInfoPlist,
} = require("expo/config-plugins");
const { mkdir, copyFile, writeFile } = require("node:fs/promises");
const path = require("node:path");
const plist = require("@expo/plist").default;
const TARGET = "ShellbellNotifications";
const SERVICE = "dev.shellbell.notifications.ShellbellMessagingService";
const EXPO_SERVICE = "expo.modules.notifications.service.ExpoFirebaseMessagingService";
const SOURCES = [
  "NotificationCrypto.swift",
  "NotificationStore.swift",
  "NotificationPolicy.swift",
  "NotificationKeychainVault.swift",
  "NotificationStoreFactory.swift",
  "NotificationPresentation.swift",
  "NotificationService.swift",
];

function notificationInfo(bundle) {
  return {
    ShellbellNotificationAppGroup: `group.${bundle}.notifications`,
    ShellbellNotificationKeychainGroup: `$(AppIdentifierPrefix)${bundle}.notifications`,
  };
}

function notificationExtensionInfo(bundle) {
  return {
    ...notificationInfo(bundle),
    CFBundleDisplayName: "Shellbell Notifications",
    CFBundleName: "$(PRODUCT_NAME)",
    CFBundleIdentifier: "$(PRODUCT_BUNDLE_IDENTIFIER)",
    CFBundleExecutable: "$(EXECUTABLE_NAME)",
    CFBundlePackageType: "XPC!",
    CFBundleShortVersionString: "$(MARKETING_VERSION)",
    CFBundleVersion: "$(CURRENT_PROJECT_VERSION)",
    NSExtension: {
      NSExtensionPointIdentifier: "com.apple.usernotifications.service",
      NSExtensionPrincipalClass: "$(PRODUCT_MODULE_NAME).NotificationService",
    },
  };
}

function configureAndroidManifest(document) {
  const manifest = document.manifest;
  manifest.$ = { ...manifest.$, "xmlns:tools": "http://schemas.android.com/tools" };
  const application = manifest.application?.[0];
  if (!application) throw new Error("Shellbell notifications requires an Android application");
  const others = (application.service ?? []).filter(
    (s) => ![SERVICE, EXPO_SERVICE].includes(s.$?.["android:name"]),
  );
  application.service = [
    ...others,
    { $: { "android:name": EXPO_SERVICE, "tools:node": "remove" } },
    {
      $: { "android:name": SERVICE, "android:exported": "false" },
      "intent-filter": [
        { action: [{ $: { "android:name": "com.google.firebase.MESSAGING_EVENT" } }] },
      ],
    },
  ];
  return document;
}

function notificationEntitlements(bundle, previous = {}) {
  const unique = (old, added) => [...new Set([...(old ?? []), ...added])];
  return {
    ...previous,
    "com.apple.security.application-groups": unique(
      previous["com.apple.security.application-groups"],
      [`group.${bundle}.notifications`],
    ),
    "keychain-access-groups": unique(previous["keychain-access-groups"], [
      `$(AppIdentifierPrefix)${bundle}`,
      `$(AppIdentifierPrefix)${bundle}.notifications`,
    ]),
  };
}

function addNotificationExtension(project, bundle, versions = {}) {
  const host = Object.values(project.pbxNativeTargetSection()).find(
    (value) => value.productType === '"com.apple.product-type.application"',
  );
  const hostConfigurations =
    project.pbxXCConfigurationList()[host?.buildConfigurationList]?.buildConfigurations ?? [];
  const existing = Object.entries(project.pbxNativeTargetSection()).find(
    ([id, value]) => !id.endsWith("_comment") && value.name?.replaceAll('"', "") === TARGET,
  );
  const target = existing
    ? { uuid: existing[0], pbxNativeTarget: existing[1] }
    : project.addTarget(TARGET, "app_extension", TARGET, `${bundle}.notifications`);
  if (!existing) {
    project.addBuildPhase(
      SOURCES.map((name) => `${TARGET}/${name}`),
      "PBXSourcesBuildPhase",
      "Sources",
      target.uuid,
    );
    project.addBuildPhase([], "PBXFrameworksBuildPhase", "Frameworks", target.uuid);
  }
  for (const name of SOURCES) {
    if (!project.hasFile(`${TARGET}/${name}`))
      project.addSourceFile(`${TARGET}/${name}`, { target: target.uuid });
  }
  const configuration =
    project.pbxXCConfigurationList()[target.pbxNativeTarget.buildConfigurationList];
  const builds = project.pbxXCBuildConfigurationSection();
  for (const entry of configuration.buildConfigurations) {
    const build = builds[entry.value];
    const hostSettings =
      hostConfigurations
        .map((entry) => builds[entry.value])
        .find((candidate) => candidate.name === build.name)?.buildSettings ?? {};
    Object.assign(builds[entry.value].buildSettings, {
      PRODUCT_BUNDLE_IDENTIFIER: `"${bundle}.notifications"`,
      PRODUCT_MODULE_NAME: "ShellbellNotificationService",
      INFOPLIST_FILE: `"${TARGET}/${TARGET}-Info.plist"`,
      CODE_SIGN_ENTITLEMENTS: `"${TARGET}/${TARGET}.entitlements"`,
      APPLICATION_EXTENSION_API_ONLY: "YES",
      SWIFT_VERSION: "5.9",
      IPHONEOS_DEPLOYMENT_TARGET: "16.4",
      TARGETED_DEVICE_FAMILY: '"1,2"',
      GENERATE_INFOPLIST_FILE: "NO",
      CODE_SIGN_STYLE: "Automatic",
      CURRENT_PROJECT_VERSION: versions.buildNumber ?? hostSettings.CURRENT_PROJECT_VERSION ?? "1",
      MARKETING_VERSION: versions.version ?? hostSettings.MARKETING_VERSION ?? "0.1.0",
      ...(hostSettings.DEVELOPMENT_TEAM ? { DEVELOPMENT_TEAM: hostSettings.DEVELOPMENT_TEAM } : {}),
    });
  }
  return project;
}

function withShellbellNotifications(config, options = {}) {
  const bundle = config.ios?.bundleIdentifier;
  if (!bundle) throw new Error("Shellbell notifications requires ios.bundleIdentifier");
  if (options.android !== false) {
    config = withAndroidManifest(config, (c) => {
      configureAndroidManifest(c.modResults);
      return c;
    });
  }
  config = withEntitlementsPlist(config, (c) => {
    c.modResults = notificationEntitlements(bundle, c.modResults);
    return c;
  });
  config = withInfoPlist(config, (c) => {
    Object.assign(c.modResults, notificationInfo(bundle));
    return c;
  });
  config = withXcodeProject(config, (c) => {
    addNotificationExtension(c.modResults, bundle, {
      version: c.version,
      buildNumber: c.ios?.buildNumber,
    });
    return c;
  });
  config = withDangerousMod(config, [
    "ios",
    async (c) => {
      const dest = path.join(c.modRequest.platformProjectRoot, TARGET);
      const source = path.join(c.modRequest.projectRoot, "modules/shellbell-notifications/ios");
      await mkdir(dest, { recursive: true });
      for (const name of SOURCES) {
        await copyFile(path.join(source, name), path.join(dest, name));
      }
      const host = notificationEntitlements(bundle);
      await writeFile(
        path.join(dest, `${TARGET}.entitlements`),
        plist.build({
          "com.apple.security.application-groups": host["com.apple.security.application-groups"],
          "keychain-access-groups": [`$(AppIdentifierPrefix)${bundle}.notifications`],
        }),
      );
      await writeFile(
        path.join(dest, `${TARGET}-Info.plist`),
        plist.build(notificationExtensionInfo(bundle)),
      );
      return c;
    },
  ]);
  return config;
}
module.exports = withShellbellNotifications;
module.exports.configureAndroidManifest = configureAndroidManifest;
module.exports.addNotificationExtension = addNotificationExtension;
module.exports.notificationEntitlements = notificationEntitlements;
module.exports.notificationInfo = notificationInfo;
module.exports.notificationExtensionInfo = notificationExtensionInfo;
