import { readFileSync, writeFileSync } from "node:fs";

const packagePath = new URL("../apps/mobile/package.json", import.meta.url);
const configPath = new URL("../apps/mobile/app.json", import.meta.url);
const { version } = JSON.parse(readFileSync(packagePath, "utf8"));
const config = JSON.parse(readFileSync(configPath, "utf8"));
if (config.expo.version !== version) {
  config.expo.version = version;
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  console.log(`Updated the static mobile version to ${version}.`);
}
