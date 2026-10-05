#!/usr/bin/env node
import { verifyBundle } from "./package-lib.mjs";

try {
  if (process.argv.length !== 3) throw Error("Usage: verify-bundle.mjs ABSOLUTE_APP_PATH");
  console.log(JSON.stringify(await verifyBundle(process.argv[2]), null, 2));
} catch (error) {
  console.error(`verify-bundle: ${error.code ?? "failed"}: ${error.message}`);
  process.exitCode = 1;
}
