#!/usr/bin/env node
import { buildDmgUsage, buildSignedDmg, parseDmgArgs } from "./signed-dmg.mjs";

try {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") console.log(buildDmgUsage);
  else {
    const result = await buildSignedDmg(parseDmgArgs(args, "build"));
    const { appFiles, ...summary } = result;
    console.log(
      JSON.stringify({ ...summary, appFileCount: Object.keys(appFiles).length }, null, 2),
    );
  }
} catch (error) {
  console.error(`native-build-signed-dmg: ${error.code ?? "failed"}`);
  if (error.mountPoint)
    console.error(
      JSON.stringify({ retainedMountPoint: error.mountPoint, retainedScratch: error.scratch }),
    );
  process.exitCode = 1;
}
