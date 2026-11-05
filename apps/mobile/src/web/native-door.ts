import type { NoiseTransportAead } from "@shellbell/protocol";
import { requireOptionalNativeModule } from "expo-modules-core";

type Generation = { generation: number };
export interface NativeWebDoor {
  listen(): [port: number, generation: number];
  stop(): void;
  read(id: number, out: Uint8Array): number;
  write(id: number, data: Uint8Array): boolean;
  shutdownOutput(id: number): void;
  close(id: number): void;
  clearWebData(): Promise<boolean>;
  aeadSeal(
    key: Uint8Array,
    nonce: Uint8Array,
    ad: Uint8Array,
    input: Uint8Array,
    out: Uint8Array,
  ): void;
  aeadOpen(
    key: Uint8Array,
    nonce: Uint8Array,
    ad: Uint8Array,
    input: Uint8Array,
    out: Uint8Array,
  ): number;
  addListener(
    event: "accepted",
    listener: (e: { id: number } & Generation) => void,
  ): { remove(): void };
  addListener(
    event: "readable",
    listener: (e: { id: number } & Generation) => void,
  ): { remove(): void };
  addListener(
    event: "written",
    listener: (e: { id: number; bytes: number } & Generation) => void,
  ): { remove(): void };
  addListener(
    event: "closed",
    listener: (e: { id: number } & Generation) => void,
  ): { remove(): void };
}

/** Android only for now; iOS gets the door in step 5 of the pages design. */
export const nativeWebDoor = requireOptionalNativeModule<NativeWebDoor>("ShellbellWebDoor");

const EMPTY = new Uint8Array(0);

/** The platform's ChaCha20-Poly1305, through typed arrays with no copies through base64. */
export function nativeTransportAead(door: NativeWebDoor): NoiseTransportAead {
  return {
    seal(key, nonce, ad, plaintext) {
      const out = new Uint8Array(plaintext.byteLength + 16);
      door.aeadSeal(key, nonce, ad.byteLength ? ad : EMPTY, plaintext, out);
      return out;
    },
    open(key, nonce, ad, ciphertext) {
      if (ciphertext.byteLength < 16) throw new Error("ciphertext too short");
      const out = new Uint8Array(ciphertext.byteLength - 16);
      if (door.aeadOpen(key, nonce, ad.byteLength ? ad : EMPTY, ciphertext, out) < 0)
        throw new Error("invalid tag");
      return out;
    },
  };
}
