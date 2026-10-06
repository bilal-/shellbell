import assert from "node:assert/strict";
import { default as rtc } from "/opt/payload/agent/node_modules/node-datachannel/dist/esm/lib/node-datachannel.mjs";

// Synthetic bytes only. Explicit loopback binding keeps ICE, DTLS and SCTP in
// the network-disabled container, with no relay, STUN server or phone involved.
assert.equal(process.platform, "linux");
const config = { iceServers: [], bindAddress: "127.0.0.1" };
const sender = new rtc.PeerConnection("archive-sender", config);
const receiver = new rtc.PeerConnection("archive-receiver", config);
let outbound;
let inbound;
let timer;
const payload = Buffer.from("Shellbell Linux native WebRTC qualification");
function fingerprint(peer) {
  const match = peer.localDescription()?.sdp.match(/^a=fingerprint:sha-256 (.+)$/m);
  assert.ok(match);
  return match[1].trim().replaceAll(":", "").toLowerCase();
}
try {
  await new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error("native direct-channel deadline")), 15000);
    const guarded =
      (callback) =>
      (...args) => {
        try {
          callback(...args);
        } catch (error) {
          reject(error);
        }
      };
    for (const [peer, other] of [
      [sender, receiver],
      [receiver, sender],
    ]) {
      peer.onLocalDescription(guarded((sdp, type) => other.setRemoteDescription(sdp, type)));
      peer.onLocalCandidate(guarded((candidate, mid) => other.addRemoteCandidate(candidate, mid)));
      peer.onStateChange(
        guarded((state) => {
          if (state === "failed") reject(new Error("native peer failed"));
        }),
      );
    }
    receiver.onDataChannel(
      guarded((channel) => {
        inbound = channel;
        assert.equal(channel.getLabel(), "shellbell-v2");
        channel.onMessage(
          guarded((bytes) => {
            assert.notEqual(typeof bytes, "string");
            assert.deepEqual(Buffer.from(bytes), payload);
            assert.equal(channel.sendMessageBinary(bytes), true);
          }),
        );
      }),
    );
    outbound = sender.createDataChannel("shellbell-v2");
    outbound.onOpen(guarded(() => assert.equal(outbound.sendMessageBinary(payload), true)));
    outbound.onMessage(
      guarded((bytes) => {
        assert.notEqual(typeof bytes, "string");
        assert.deepEqual(Buffer.from(bytes), payload);
        assert.equal(sender.state(), "connected");
        assert.equal(receiver.state(), "connected");
        assert.equal(sender.remoteFingerprint().algorithm.toLowerCase(), "sha-256");
        assert.equal(receiver.remoteFingerprint().algorithm.toLowerCase(), "sha-256");
        assert.equal(
          sender.remoteFingerprint().value.replaceAll(":", "").toLowerCase(),
          fingerprint(receiver),
        );
        assert.equal(
          receiver.remoteFingerprint().value.replaceAll(":", "").toLowerCase(),
          fingerprint(sender),
        );
        resolve();
      }),
    );
  });
  console.log(
    JSON.stringify({
      platform: process.platform,
      arch: process.arch,
      checks: [
        "packaged native library loads",
        "real ICE and DTLS",
        "binary SCTP roundtrip",
        "peer certificate fingerprints",
      ],
      phoneTested: false,
      relayContacted: false,
    }),
  );
} finally {
  clearTimeout(timer);
  outbound?.close();
  inbound?.close();
  sender.close();
  receiver.close();
  rtc.cleanup();
}
