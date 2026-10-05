// Local-only native WebRTC feasibility probe. Never sends Shellbell keys or terminal data.
import { Stack } from "expo-router";
import { useEffect, useState } from "react";
import { ScrollView, Text } from "react-native";
import { RTCPeerConnection, RTCSessionDescription } from "react-native-webrtc";
import { verifyRemoteDtlsFingerprint } from "../../src/net/direct/fingerprint";

export default function WebRtcFeasibility() {
  const [result, setResult] = useState("Connecting to local probe…");

  useEffect(() => {
    if (!__DEV__) return;
    const socket = new WebSocket("ws://127.0.0.1:39999");
    const peer = new RTCPeerConnection({ iceServers: [] });
    const channel = peer.createDataChannel("shellbell-feasibility", { ordered: true });
    const pendingCandidates: Array<{ candidate: string; mid: string }> = [];
    let remoteDescriptionSet = false;
    let signaledFingerprint: string | null = null;
    let phoneLocalFingerprint: string | null = null;
    let nodeObservedPhoneFingerprint: string | null = null;
    let finished = false;
    const report = (text: string) => {
      console.log("WEBRTC_FEASIBILITY", text);
      setResult(text);
    };
    const inspect = async () => {
      for (let attempt = 0; attempt < 20 && !finished; attempt++) {
        const stats = await peer.getStats();
        const values = Array.from(stats.values()) as Array<Record<string, unknown>>;
        const transports = values.filter((value) => value.type === "transport");
        const certificates = values.filter((value) => value.type === "certificate");
        const remoteId = transports.find(
          (value) => typeof value.remoteCertificateId === "string",
        )?.remoteCertificateId;
        const remote = certificates.find((value) => value.id === remoteId);
        if (remote && nodeObservedPhoneFingerprint) {
          finished = true;
          if (signaledFingerprint === null) {
            report("Echo received, but signaled SDP fingerprint was missing");
            return;
          }
          const verified = verifyRemoteDtlsFingerprint(stats, {
            algorithm: "sha-256",
            value: signaledFingerprint,
          });
          if (
            phoneLocalFingerprint === null ||
            nodeObservedPhoneFingerprint.toUpperCase() !== phoneLocalFingerprint.toUpperCase()
          ) {
            report("Node's live remote certificate did not match the phone SDP fingerprint");
            return;
          }
          report(
            JSON.stringify(
              {
                result: "data-channel echo succeeded",
                signaledFingerprint,
                verifiedFingerprint: verified,
                phoneLocalFingerprint,
                nodeObservedPhoneFingerprint,
                remoteCertificateId: remoteId,
                remoteFingerprint: remote.fingerprint,
                fingerprintAlgorithm: remote.fingerprintAlgorithm,
                transportCount: transports.length,
                dtlsState: transports[0]?.dtlsState,
                certificateCount: certificates.length,
              },
              null,
              2,
            ),
          );
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (!finished) {
        const stats = await peer.getStats();
        report(
          JSON.stringify(
            {
              result: "data-channel echo succeeded, remote certificate unavailable",
              stats: Array.from(stats.values()).map((value) => {
                const item = value as Record<string, unknown>;
                return { type: item.type, id: item.id };
              }),
            },
            null,
            2,
          ),
        );
      }
    };
    socket.onopen = async () => {
      try {
        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        phoneLocalFingerprint =
          /^a=fingerprint:sha-256 ([0-9A-Fa-f:]+)/m.exec(offer.sdp ?? "")?.[1] ?? null;
        socket.send(JSON.stringify({ type: "description", sdp: offer.sdp, sdpType: offer.type }));
      } catch (error) {
        report(`Offer failed: ${String(error)}`);
      }
    };
    socket.onmessage = async (event) => {
      try {
        const message = JSON.parse(String(event.data));
        if (message.type === "description") {
          signaledFingerprint =
            /^a=fingerprint:sha-256 ([0-9A-Fa-f:]+)/m.exec(message.sdp)?.[1] ?? null;
          await peer.setRemoteDescription(
            new RTCSessionDescription({
              sdp: message.sdp,
              type: message.sdpType,
            }),
          );
          remoteDescriptionSet = true;
          for (const candidate of pendingCandidates) {
            await peer.addIceCandidate({ candidate: candidate.candidate, sdpMid: candidate.mid });
          }
        } else if (message.type === "node-fingerprint") {
          if (message.fingerprint?.algorithm !== "sha-256") {
            report("Node did not report a SHA-256 remote certificate fingerprint");
            return;
          }
          nodeObservedPhoneFingerprint = message.fingerprint.value;
        } else if (message.type === "candidate") {
          if (remoteDescriptionSet) {
            await peer.addIceCandidate({ candidate: message.candidate, sdpMid: message.mid });
          } else {
            pendingCandidates.push(message);
          }
        } else if (message.type === "error") {
          report(`Node error: ${message.message}`);
        }
      } catch (error) {
        report(`Signaling failed: ${String(error)}`);
      }
    };
    socket.onerror = () => report("Local probe WebSocket failed");
    peer.onicecandidate = (event: {
      candidate: { candidate: string; sdpMid: string | null } | null;
    }) => {
      if (event.candidate?.sdpMid && socket.readyState === WebSocket.OPEN) {
        socket.send(
          JSON.stringify({
            type: "candidate",
            candidate: event.candidate.candidate,
            mid: event.candidate.sdpMid,
          }),
        );
      }
    };
    channel.onopen = () => channel.send(new Uint8Array([115, 98, 45, 112, 114, 111, 98, 101]));
    channel.onmessage = (event: { data: unknown }) => {
      report(`Echo received (${typeof event.data}); checking live certificate stats…`);
      void inspect().catch((error) => report(`Stats failed: ${String(error)}`));
    };
    return () => {
      finished = true;
      channel.close();
      peer.close();
      socket.close();
    };
  }, []);

  return (
    <ScrollView style={{ flex: 1, backgroundColor: "#000", padding: 20 }}>
      <Stack.Screen options={{ title: "WebRTC native probe" }} />
      <Text selectable style={{ color: "#fff", fontSize: 16 }}>
        {result}
      </Text>
    </ScrollView>
  );
}
