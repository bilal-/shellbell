import type { NetworkSnapshot } from "../net/network-monitor";
import type { ComputerConn } from "../store/connections";

export interface TransportPresentation {
  label: string;
  detail: string;
  tone: "direct" | "relay" | "pending" | "offline";
  busy: boolean;
  allowRelay: boolean;
}

function directRetryDetail(failure: string | null): string {
  const reasons: Record<string, string> = {
    "native-create": "WebRTC could not start on this device.",
    "native-closed": "The direct connection closed.",
    certificate: "The direct connection could not be verified.",
    timeout: "The devices could not reach each other directly.",
    "local-description": "The devices could not negotiate a direct connection.",
    "native-description": "The devices could not negotiate a direct connection.",
    "local-candidate": "WebRTC could not prepare a network address.",
  };
  const reason = failure !== null && Object.hasOwn(reasons, failure) ? reasons[failure] : undefined;
  return `Terminal paused. ${reason ? `${reason} ` : ""}Retrying automatically.`;
}

export function transportPresentation(
  connection: ComputerConn | undefined,
  network: NetworkSnapshot,
): TransportPresentation {
  const base = { tone: "pending" as const, busy: true, allowRelay: false };
  if (connection?.status === "error")
    return {
      ...base,
      label: "Connection needs attention",
      detail: "Open computer settings to check the connection.",
      tone: "offline",
      busy: false,
    };
  if (network.disconnected)
    return {
      ...base,
      label: "No internet",
      detail: "Terminal paused. Waiting for a network connection.",
      tone: "offline",
      busy: false,
    };
  if (connection?.offlineReason === "computer")
    return {
      ...base,
      label: "Computer offline",
      detail: "Terminal paused. Waiting for your computer.",
      tone: "offline",
      busy: false,
    };
  const transport = connection?.transport;
  if (connection?.status === "online" && transport?.ready === false)
    return {
      ...base,
      label: "Switching connection",
      detail: "Terminal paused until both devices confirm the connection.",
    };
  if (connection?.status === "online" && transport?.route === "direct")
    return {
      ...base,
      label: "Direct",
      detail: "Terminal traffic goes directly to your computer.",
      tone: "direct",
      busy: false,
    };
  if (connection?.status === "online" && transport?.route === "relay")
    return {
      ...base,
      label: "Relay fallback",
      detail: "Terminal traffic is using the encrypted relay. Still trying to connect directly.",
      tone: "relay",
      busy: false,
    };
  if (connection?.status === "online")
    return { ...base, label: "Connected", detail: "Checking the terminal transport." };
  if (connection?.status === "waiting-direct") {
    const available = { ...base, allowRelay: transport?.route === "relay" && transport.ready };
    if (transport?.retryPending)
      return {
        ...available,
        label: "Direct connection unavailable",
        detail: directRetryDetail(transport.lastFailure),
      };
    if (transport?.phase === "certificate" || transport?.phase === "noise")
      return {
        ...available,
        label: "Verifying direct connection",
        detail: "Terminal paused while the encrypted connection is verified.",
      };
    if (transport?.phase === "cutover")
      return {
        ...available,
        label: "Switching to direct",
        detail: "Terminal paused until both devices confirm the connection.",
      };
    return {
      ...available,
      label: "Connecting directly",
      detail: "Establishing WebRTC. Terminal paused.",
    };
  }
  if (connection?.status === "auth")
    return {
      ...base,
      label: "Authenticating",
      detail: "Connecting securely to the relay for negotiation.",
    };
  if (connection?.status === "handshake")
    return {
      ...base,
      label: "Securing connection",
      detail: "Confirming your computer before connecting directly.",
    };
  return {
    ...base,
    label: connection?.sessions.length ? "Reconnecting" : "Connecting",
    detail: "Contacting the relay to negotiate a direct connection.",
  };
}
