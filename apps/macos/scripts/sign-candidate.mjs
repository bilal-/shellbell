#!/usr/bin/env node
import { parseCandidateArgs, signCandidate, signUsage } from "./signed-candidate.mjs";

try {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") console.log(signUsage);
  else {
    const report = await signCandidate(parseCandidateArgs(args, "sign"));
    console.log(
      JSON.stringify(
        { ...report, files: undefined, fileCount: Object.keys(report.files).length },
        null,
        2,
      ),
    );
  }
} catch (error) {
  // Do not dump subprocess arguments, signing identity or account diagnostics.
  console.error(
    `native-sign-candidate: ${error.code ?? "failed"}; no release-ready artifact claimed`,
  );
  process.exitCode = 1;
}
