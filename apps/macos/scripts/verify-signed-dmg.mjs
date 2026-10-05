#!/usr/bin/env node
import { parseDmgArgs, verifyDmgUsage, verifySignedDmgReport } from "./signed-dmg.mjs";

try {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") console.log(verifyDmgUsage);
  else {
    const options = parseDmgArgs(args, "verify");
    const result = await verifySignedDmgReport(options);
    const { appFiles, ...summary } = result;
    console.log(
      JSON.stringify(
        {
          ...summary,
          report: options.report,
          appFileCount: Object.keys(appFiles).length,
        },
        null,
        2,
      ),
    );
  }
} catch (error) {
  console.error(`native-verify-signed-dmg: ${error.code ?? "failed"}`);
  if (error.mountPoint)
    console.error(
      JSON.stringify({ retainedMountPoint: error.mountPoint, retainedScratch: error.scratch }),
    );
  process.exitCode = 1;
}
