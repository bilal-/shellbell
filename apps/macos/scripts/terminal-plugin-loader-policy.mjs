import { createHash } from "node:crypto";
import { relative } from "node:path";

// This sole dynamic boundary loads owner-approved local ESM, never packaged dependencies.
// Pin the unbundled source bytes rather than exempting arbitrary computed imports.
export function admitTerminalPluginLoader(agent, file, text) {
  if (relative(agent, file) !== "runtime/terminal-plugin-loader.mjs") return false;
  const digest = createHash("sha256").update(text).digest("hex");
  if (digest !== "59c37eb34a116e9cdebf33445d25d7aef1a187345270e75a5689f8669c404846")
    throw new Error("import-closure: terminal plugin loader integrity mismatch");
  return true;
}
