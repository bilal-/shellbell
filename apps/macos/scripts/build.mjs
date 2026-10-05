#!/usr/bin/env node
import { build, parseBuildArgs } from "./package-lib.mjs";

try {
  await build(parseBuildArgs(process.argv.slice(2)));
} catch (error) {
  console.error(`native-build: ${error.code ?? "failed"}: ${error.message}`);
  process.exitCode = 1;
}
