import { setNoiseTransportAead } from "@shellbell/protocol";
import { nativeTransportAead, nativeWebDoor } from "../web/native-door";

// Select the platform transport cipher only after cross-implementation and
// boundary checks. The handshake continues to use the protocol implementation.
export const nativeCipherMode =
  nativeWebDoor && setNoiseTransportAead(nativeTransportAead(nativeWebDoor))
    ? "native"
    : "javascript";
if (nativeWebDoor && nativeCipherMode !== "native")
  console.warn("native transport cipher failed self-check; using JavaScript");
console.info(`transport cipher: ${nativeCipherMode}`);
