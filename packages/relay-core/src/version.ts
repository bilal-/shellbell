import relayPackage from "../package.json" with { type: "json" };

/** Both supplied relay runtimes share this release version. */
export const RELAY_VERSION = relayPackage.version;
