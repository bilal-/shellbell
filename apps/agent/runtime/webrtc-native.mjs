// The native WebRTC binary Shellbell builds itself from pinned sources (native/webrtc), one
// per platform. Nothing else loads native code, and only this file chooses which binary.
import { createRequire } from "node:module";

const targets = {
  "darwin-arm64": "darwin-arm64",
  "darwin-x64": "darwin-x64",
  "linux-arm64": "linux-arm64-gnu",
  "linux-x64": "linux-x64-gnu",
};
const target = targets[`${process.platform}-${process.arch}`];
if (!target) throw new Error(`No WebRTC binary for ${process.platform} (${process.arch})`);
export default createRequire(import.meta.url)(`../webrtc/${target}/node_datachannel.node`);
