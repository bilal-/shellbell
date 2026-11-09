import { nobleTransportAead, setNoiseTransportAead } from "@shellbell/protocol";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("expo-modules-core", () => ({ requireOptionalNativeModule: () => null }));

import { type NativeWebDoor, nativeTransportAead } from "../src/web/native-door";

afterEach(() => {
  setNoiseTransportAead(nobleTransportAead);
});
function bridge() {
  return {
    aeadSeal(k, n, a, p, out) {
      out.set(nobleTransportAead.seal(k, n, a, p));
    },
    aeadOpen(k, n, a, c, out) {
      try {
        const plain = nobleTransportAead.open(k, n, a, c);
        out.set(plain);
        return plain.length;
      } catch {
        return -1;
      }
    },
  } satisfies Pick<NativeWebDoor, "aeadSeal" | "aeadOpen">;
}
it("selects a bridge only after all transport boundary checks pass", () => {
  expect(setNoiseTransportAead(nativeTransportAead(bridge() as NativeWebDoor))).toBe(true);
});
it("rejects an unexpected native plaintext length", () => {
  const door = bridge();
  door.aeadOpen = () => 1;
  const cipher = nativeTransportAead(door as NativeWebDoor);
  expect(() =>
    cipher.open(new Uint8Array(32), new Uint8Array(12), new Uint8Array(), new Uint8Array(16)),
  ).toThrow("plaintext length");
});
