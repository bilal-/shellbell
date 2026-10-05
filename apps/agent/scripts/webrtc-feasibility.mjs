// Local-only data-channel/certificate probe. No Shellbell keys or terminal data.
// Run from the repo root: pnpm -F shellbell exec node scripts/webrtc-feasibility.mjs
import datachannel from "node-datachannel";
import { WebSocketServer } from "ws";

const server = new WebSocketServer({ host: "127.0.0.1", port: 39999 });
console.log("WebRTC feasibility probe listening on 127.0.0.1:39999");

server.on("connection", (socket) => {
  const peer = new datachannel.PeerConnection("shellbell-feasibility", { iceServers: [] });
  const send = (message) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
  };
  peer.onLocalDescription((sdp, type) => send({ type: "description", sdp, sdpType: type }));
  peer.onLocalCandidate((candidate, mid) => send({ type: "candidate", candidate, mid }));
  peer.onDataChannel((channel) => {
    channel.onOpen(() => {
      send({ type: "node-fingerprint", fingerprint: peer.remoteFingerprint() });
    });
    channel.onMessage((message) => channel.sendMessageBinary(message));
  });
  socket.on("message", (raw) => {
    try {
      const message = JSON.parse(String(raw));
      if (message.type === "description" && message.sdpType === "offer") {
        peer.setRemoteDescription(message.sdp, "offer");
      } else if (message.type === "candidate") {
        peer.addRemoteCandidate(message.candidate, message.mid);
      }
    } catch (error) {
      send({ type: "error", message: String(error) });
    }
  });
  socket.on("close", () => peer.close());
});
