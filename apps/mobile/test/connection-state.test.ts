import { describe, expect, it } from "vitest";
import { networkSnapshot, UNKNOWN_NETWORK } from "../src/net/network-monitor";
import { useConnectionsStore } from "../src/store/connections";
import { connectionNotice } from "../src/util/connection-state";

describe("connection messages", () => {
  const connection = {
    ...useConnectionsStore.getState().read("fixture"),
    status: "offline" as const,
  };
  it("reports the phone being offline without blaming the computer", () => {
    const network = networkSnapshot({ type: "NONE" });
    expect(connectionNotice(connection, network, "Laptop")).toBe("No internet connection");
    expect(connectionNotice(undefined, network)).toBe("No internet connection");
  });
  it("only names the computer as offline after authoritative relay presence", () => {
    expect(
      connectionNotice({ ...connection, offlineReason: "computer" }, UNKNOWN_NETWORK, "Laptop"),
    ).toBe("Laptop is offline");
    expect(
      connectionNotice({ ...connection, offlineReason: "relay" }, UNKNOWN_NETWORK, "Laptop"),
    ).toBe("Connecting…");
  });
  it("shows recovery when a cached session list exists", () => {
    expect(connectionNotice({ ...connection, sessions: [{} as never] }, UNKNOWN_NETWORK)).toBe(
      "Reconnecting…",
    );
  });
  it("does not promise reconnection for an error requiring user action", () => {
    expect(
      connectionNotice({ ...connection, status: "error", error: "re-pair" }, UNKNOWN_NETWORK),
    ).toBe("Connection needs attention");
  });
});
