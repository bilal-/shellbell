#!/usr/bin/env node
import { makeDmg } from "./package-lib.mjs";

try {
  if (process.argv.length !== 4)
    throw Error("Usage: make-dmg.mjs ABSOLUTE_APP_PATH ABSOLUTE_NEW_DMG_PATH");
  console.log(JSON.stringify(await makeDmg(process.argv[2], process.argv[3]), null, 2));
} catch (error) {
  console.error(`make-dmg: ${error.code ?? "failed"}: ${error.message}`);
  process.exitCode = 1;
}
