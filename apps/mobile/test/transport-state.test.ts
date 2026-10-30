import { describe, expect, it } from "vitest";
import { networkSnapshot, UNKNOWN_NETWORK } from "../src/net/network-monitor";
import { useConnectionsStore } from "../src/store/connections";
import {
  transportIndicator,
  transportPaused,
  transportPresentation,
} from "../src/util/transport-state";

const connection = {
  ...useConnectionsStore.getState().read("fixture"),
  status: "online" as const,
  transport: {
    route: "direct" as const,
    ready: true,
    phase: "direct" as const,
    retryPending: false,
    lastFailure: null,
  },
};
describe("visible terminal transport", () => {
  it("uses the committed route rather than the phone's network type", () => {
    for (const type of ["WIFI", "CELLULAR"] as const) {
      const network = networkSnapshot({ type, isConnected: true });
      expect(transportPresentation(connection, network).label).toBe("Direct");
    }
  });
  it("pauses a direct route whose computer stopped answering, and says so", () => {
    expect(transportPaused(connection)).toBe(false);
    expect(transportPaused({ ...connection, quiet: true })).toBe(true);
    expect(transportPresentation({ ...connection, quiet: true }, UNKNOWN_NETWORK)).toMatchObject({
      label: "Computer not answering",
      detail: "It may be asleep. What you see may be out of date.",
      tone: "offline",
    });
  });
  it("shows negotiation and offers no relay choice", () => {
    expect(
      transportPresentation(
        { ...connection, transport: { ...connection.transport, ready: false } },
        UNKNOWN_NETWORK,
      ),
    ).toMatchObject({ label: "Switching connection" });
    const pending = {
      ...connection,
      status: "waiting-direct" as const,
      transport: { ...connection.transport, route: "relay" as const, phase: "connecting" as const },
    };
    expect(transportPresentation(pending, UNKNOWN_NETWORK)).toEqual({
      label: "Connecting directly",
      detail: "Establishing WebRTC. Terminal paused.",
      tone: "pending",
      busy: true,
    });
    expect(
      transportPresentation(
        { ...pending, transport: { ...pending.transport, phase: "noise" } },
        UNKNOWN_NETWORK,
      ).label,
    ).toBe("Verifying direct connection");
    expect(
      transportPresentation(
        {
          ...pending,
          transport: { ...pending.transport, retryPending: true, lastFailure: "timeout" },
        },
        UNKNOWN_NETWORK,
      ),
    ).toMatchObject({
      label: "Direct connection unavailable",
      detail:
        "Terminal paused. The devices could not reach each other directly. Retrying automatically.",
    });
  });
  it("explains why the terminal is paused while offline or uncommitted", () => {
    const pending = { ...connection, status: "waiting-direct" as const };
    expect(transportPresentation(pending, networkSnapshot({ type: "NONE" }))).toMatchObject({
      label: "No internet",
    });
    expect(
      transportPresentation(
        { ...pending, transport: { ...pending.transport, route: null } },
        UNKNOWN_NETWORK,
      ).label,
    ).toBe("Connecting directly");
    expect(
      transportPresentation(
        { ...connection, status: "offline", offlineReason: "computer" },
        UNKNOWN_NETWORK,
      ).label,
    ).toBe("Computer offline");
  });
});

describe("session header connection dot", () => {
  it("is quiet while direct and says Connecting while waiting for direct", () => {
    expect(transportIndicator(connection, UNKNOWN_NETWORK)).toEqual({ tone: "ok", word: null });
    expect(
      transportIndicator(
        {
          ...connection,
          status: "waiting-direct",
          transport: { ...connection.transport, route: "relay", phase: "connecting" },
        },
        UNKNOWN_NETWORK,
      ),
    ).toEqual({ tone: "degraded", word: "Connecting" });
    expect(
      transportIndicator(
        { ...connection, transport: { ...connection.transport, ready: false } },
        UNKNOWN_NETWORK,
      ),
    ).toEqual({ tone: "degraded", word: "Connecting" });
    expect(
      transportIndicator({ ...connection, status: "waiting-direct" }, UNKNOWN_NETWORK),
    ).toEqual({ tone: "degraded", word: "Connecting" });
    expect(transportIndicator(undefined, UNKNOWN_NETWORK)).toEqual({
      tone: "degraded",
      word: "Connecting",
    });
  });
  it("separates offline from a connection that needs the user", () => {
    expect(
      transportIndicator(
        { ...connection, status: "offline", offlineReason: "computer" },
        UNKNOWN_NETWORK,
      ),
    ).toEqual({ tone: "offline", word: "Offline" });
    expect(
      transportIndicator(
        { ...connection, status: "waiting-direct" },
        networkSnapshot({ type: "NONE" }),
      ),
    ).toEqual({ tone: "offline", word: "Offline" });
    expect(transportIndicator({ ...connection, status: "error" }, UNKNOWN_NETWORK)).toEqual({
      tone: "error",
      word: "Needs attention",
    });
  });
});
