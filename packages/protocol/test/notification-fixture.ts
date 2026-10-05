import { toBase64Url } from "../src/bytes.js";

export const notificationHeader = {
  computerFp: "a".repeat(26),
  phoneFp: "b".repeat(26),
  generation: toBase64Url(new Uint8Array(16).fill(1)),
  sessionId: "tmux:1",
  eventId: toBase64Url(new Uint8Array(16).fill(2)),
};
export const notificationPayload = {
  ...notificationHeader,
  context: {
    computerName: "MacBook",
    sessionLabel: "Terminal 2",
    observedAt: 1000,
    repository: "shellbell",
    branch: "main",
  },
  reason: "agent-blocked" as const,
  issuedAt: 1000,
  expiresAt: 121000,
  sequence: "1",
};
