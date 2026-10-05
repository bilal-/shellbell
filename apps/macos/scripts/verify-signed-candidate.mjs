#!/usr/bin/env node
import { parseCandidateArgs, verifyUsage } from "./signed-candidate.mjs";
import { verifySignedCandidate } from "./signed-verification.mjs";

try {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") console.log(verifyUsage);
  else {
    const { app, teamId } = parseCandidateArgs(args, "verify");
    console.log(JSON.stringify(await verifySignedCandidate(app, { teamId }), null, 2));
  }
} catch (error) {
  console.error(`native-verify-signed-candidate: ${error.code ?? "failed"}`);
  process.exitCode = 1;
}
