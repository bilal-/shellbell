import { describe, expect, it } from "vitest";
import { networkSnapshot, UNKNOWN_NETWORK } from "../src/net/network-monitor";
import { useConnectionsStore } from "../src/store/connections";
import { transportPresentation } from "../src/util/transport-state";

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
      expect(
        transportPresentation(
          { ...connection, transport: { ...connection.transport, route: "relay" } },
          network,
        ).label,
      ).toBe("Relay fallback");
    }
  });
  it("shows negotiation and permits only an explicit relay exception", () => {
    expect(
      transportPresentation(
        { ...connection, transport: { ...connection.transport, ready: false } },
        UNKNOWN_NETWORK,
      ),
    ).toMatchObject({ label: "Switching connection", allowRelay: false });
    const pending = {
      ...connection,
      status: "waiting-direct" as const,
      transport: { ...connection.transport, route: "relay" as const, phase: "connecting" as const },
    };
    expect(transportPresentation(pending, UNKNOWN_NETWORK)).toMatchObject({
      label: "Connecting directly",
      allowRelay: true,
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
  it("does not offer relay traffic while offline or uncommitted", () => {
    const pending = { ...connection, status: "waiting-direct" as const };
    expect(transportPresentation(pending, networkSnapshot({ type: "NONE" }))).toMatchObject({
      label: "No internet",
      allowRelay: false,
    });
    expect(
      transportPresentation(
        { ...pending, transport: { ...pending.transport, route: null } },
        UNKNOWN_NETWORK,
      ).allowRelay,
    ).toBe(false);
    expect(
      transportPresentation(
        { ...connection, status: "offline", offlineReason: "computer" },
        UNKNOWN_NETWORK,
      ).label,
    ).toBe("Computer offline");
  });
});
