import { type DirectRouteStats, directRoutePath } from "@shellbell/protocol";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * The route WebRTC chose, from the transport's selected candidate pair (or, when a platform
 * doesn't name it, the nominated pair that succeeded). Null until a pair carries traffic.
 */
export function directRouteStats(stats: ReadonlyMap<string, unknown>): DirectRouteStats | null {
  let pair: Record<string, unknown> | null = null;
  for (const raw of stats.values()) {
    const transport = record(raw);
    if (transport?.type === "transport" && typeof transport.selectedCandidatePairId === "string")
      pair = record(stats.get(transport.selectedCandidatePairId));
  }
  if (!pair)
    for (const raw of stats.values()) {
      const candidate = record(raw);
      if (
        candidate?.type === "candidate-pair" &&
        candidate.state === "succeeded" &&
        candidate.nominated === true
      )
        pair = candidate;
    }
  if (pair?.type !== "candidate-pair") return null;
  const local = record(stats.get(String(pair.localCandidateId)));
  const remote = record(stats.get(String(pair.remoteCandidateId)));
  if (!local || !remote) return null;
  const rtt = pair.currentRoundTripTime;
  const rttMs = typeof rtt === "number" && rtt >= 0 ? Math.round(rtt * 1000) : undefined;
  const transport = local.relayProtocol;
  return {
    path: directRoutePath(local.candidateType, remote.candidateType),
    // Only this device's own TURN allocation says how it reaches the TURN server.
    ...(local.candidateType === "relay" &&
      (transport === "udp" || transport === "tcp" || transport === "tls") && {
        turnTransport: transport,
      }),
    ...(rttMs !== undefined && { rttMs }),
  };
}
