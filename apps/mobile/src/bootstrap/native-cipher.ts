import { setNoiseTransportAead } from "@shellbell/protocol";
import { nativeTransportAead, nativeWebDoor } from "../web/native-door";

// Hermes runs ChaCha20-Poly1305 at about 4 MB/s on a Galaxy S22; the platform cipher runs at
// over 200 MB/s. The swap checks the native cipher against RFC 8439's vector first and keeps
// noble when it disagrees.
if (nativeWebDoor) {
  if (setNoiseTransportAead(nativeTransportAead(nativeWebDoor))) {
    if (__DEV__) console.info("transport cipher: native");
  } else console.warn("native transport cipher failed its self-check; using JavaScript");
}
