import type { NetworkSnapshot } from "../net/network-monitor";
import type { ComputerConn } from "../store/connections";

/** Relay loss alone cannot establish that the computer is offline. */
export function connectionNotice(
  connection: ComputerConn | undefined,
  network: NetworkSnapshot,
  computerName = "Computer",
): string {
  if (connection?.status === "error") return "Connection needs attention";
  if (connection?.status === "waiting-direct" && !network.disconnected)
    return "Terminal paused · Connecting directly";
  if (connection?.status === "online" && connection.transport?.ready === false)
    return "Terminal paused · Switching connection";
  if (network.internet === "offline") return "No internet connection";
  if (connection?.offlineReason === "computer") return `${computerName} is offline`;
  return connection?.sessions.length ? "Reconnecting…" : "Connecting…";
}
