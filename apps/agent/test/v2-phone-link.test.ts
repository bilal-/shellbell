import type { V2EndpointOptions } from "@shellbell/protocol";
import { describe, expect, it, vi } from "vitest";

const endpoints = vi.hoisted(() => [] as V2EndpointOptions[]);
vi.mock("@shellbell/protocol", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@shellbell/protocol")>()),
  // A class, so formatting cannot turn it into an arrow that `new` rejects.
  V2PairEndpoint: vi.fn(
    class {
      constructor(options: V2EndpointOptions) {
        endpoints.push(options);
      }
    },
  ),
}));

import { helloOverdueWarning } from "../src/agent.js";
import type { Logger } from "../src/log.js";
import { V2_HELLO_TIMEOUT_MS, V2PhoneLink } from "../src/v2-phone-link.js";

function link() {
  const ready: unknown[] = [];
  const warnings: Array<[string, Record<string, unknown> | undefined]> = [];
  const log: Logger = {
    debug() {},
    info() {},
    warn: (msg, fields) => warnings.push([msg, fields]),
    error() {},
    child: () => log,
  };
  const created = new V2PhoneLink({
    phoneFp: "phone-fingerprint-0123",
    connId: "conn-0123456789",
    name: "Phone",
    computerFp: "computer",
    identity: { x25519: { priv: new Uint8Array(32) } } as never,
    kPair: new Uint8Array(32),
    remoteStatic: new Uint8Array(32),
    send: () => true,
    commitFloor: async () => {},
    prepareReady: () => true,
    terminal() {},
    ready: (source) => ready.push(source),
    log,
    native: async () => {
      throw new Error("unused");
    },
  });
  return { link: created, warnings, ready, endpoint: endpoints.at(-1)! };
}

describe("V2PhoneLink diagnostics", () => {
  it("logs a direct failure's code and phase without addresses or keys", () => {
    const { endpoint, warnings } = link();
    endpoint.failure("direct", { code: "timeout", phase: "connecting" });
    endpoint.failure("bootstrap");
    expect(warnings).toEqual([
      [
        "v2 transport failed",
        { stage: "direct", code: "timeout", phase: "connecting", phone: "phone-fi" },
      ],
      ["v2 transport failed", { stage: "bootstrap", phone: "phone-fi" }],
    ]);
  });

  it("treats the phone as unready until terminal data arrives on the direct route", () => {
    const { link: created, endpoint, ready } = link();
    endpoint.routeChanged("relay", 1);
    expect(created.handshaken).toBe(false);
    expect(ready).toEqual([created]);
    endpoint.routeChanged("direct", 2);
    expect(created.handshaken).toBe(false);
  });

  it("does not report a missing hello once the encrypted handshake has completed", () => {
    const { link: created, endpoint } = link();
    endpoint.routeChanged("relay", 1);
    // A slow WebRTC retry is reported as a direct failure, not as a missing hello.
    expect(created.helloOverdue(created.openedAt + V2_HELLO_TIMEOUT_MS * 4)).toBe(false);
  });

  it("names the hello deadline it actually waits for", () => {
    const { link: created } = link();
    expect(created.helloTimeoutMs).toBe(V2_HELLO_TIMEOUT_MS);
    expect(created.helloOverdue(created.openedAt + V2_HELLO_TIMEOUT_MS - 1)).toBe(false);
    expect(created.helloOverdue(created.openedAt + V2_HELLO_TIMEOUT_MS)).toBe(true);
    expect(helloOverdueWarning(created.helloTimeoutMs)).toBe(
      `no conn.hello within ${V2_HELLO_TIMEOUT_MS / 1000}s; ignoring this link until one arrives`,
    );
    expect(helloOverdueWarning(15_000)).toContain("within 15s");
  });
});
