import { dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { installPayload, removeInstallation } from "./scripts/install-lib.mjs";
import { fail, validVersion, verifyPayload } from "./scripts/payload.mjs";

try {
  if (process.platform !== "linux" || !["arm64", "x64"].includes(process.arch))
    fail("unsupported-platform");
  const home = process.env.HOME;
  if (!home || !isAbsolute(home) || home === "/") fail("invalid-home");
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--uninstall") {
    const result = await removeInstallation({ home });
    console.log(
      `Removed ${result.removedVersions} installed versions and the managed launcher. Pairing and host state were preserved.`,
    );
  } else {
    let version;
    let expectedCurrent;
    const seen = new Set();
    for (let index = 0; index < args.length; index += 2) {
      const option = args[index];
      const value = args[index + 1];
      if (
        !["--expected-version", "--update-from"].includes(option) ||
        seen.has(option) ||
        !validVersion(value)
      ) {
        fail(
          "usage: bundled-node install.mjs [--expected-version VERSION] [--update-from VERSION] | --uninstall",
        );
      }
      seen.add(option);
      if (option === "--update-from") expectedCurrent = value;
      else version = value;
    }
    if (expectedCurrent && !version) fail("update-requires-expected-version");
    const payload = dirname(fileURLToPath(import.meta.url));
    await verifyPayload(payload, { arch: process.arch, version });
    const result = await installPayload({ payload, home, expectedCurrent });
    console.log(`Installed Shellbell ${result.version} for this user at ${result.location}`);
    console.log(`Launcher: ${result.launcher}`);
    console.log("No identity, pairing or service was created or changed.");
    console.log(
      "Add ~/.local/bin to your PATH if needed. For a new host: shellbell host init --new; then shellbell start.",
    );
    console.log(
      "Optional persistence: shellbell service install; shellbell service start; shellbell service enable. Check shellbell doctor.",
    );
    console.log(
      "Existing services keep their previous pinned runtime; stop/install/start explicitly to upgrade them. Linger is a separate administrator decision.",
    );
  }
} catch (error) {
  console.error(`Shellbell installation failed: ${error.message}`);
  process.exitCode = 1;
}
