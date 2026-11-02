import { agentName } from "../input/agentPrompt";
import { INPUT_DELIVERY_UNKNOWN } from "../input/fireInput";

/** How long a confirmed send says "Sent" before it fades (owner decision D2). */
export const RECEIPT_SENT_FADE_MS = 5000;

/** The latest send from Chat: one receipt, never matched to transcript rows. */
export interface SendReceipt {
  /** The request ID, so only this send's outcome may change it. */
  readonly id: string;
  readonly state: "sending" | "sent" | "refused" | "unknown";
  readonly text: string;
}

function who(agent: string | undefined): string {
  return agentName(agent) ?? "the agent";
}

function possessive(agent: string | undefined): string {
  const name = agentName(agent);
  return name ? `${name}’s` : "The agent’s";
}

/** Not sure it arrived: never retried by itself, and the draft stays for a deliberate retry. */
export function unknownText(agent: string | undefined): string {
  return `Not sure this reached ${who(agent)}. Check the chat before sending again.`;
}

/** What a refusal from the computer means, in plain words. The draft always stays. */
export function refusalText(error: string | undefined, agent: string | undefined): string {
  switch (error) {
    case "busy":
      return "Your computer is still busy with earlier input. Try again in a moment.";
    case "conversation-changed":
      return `${possessive(agent)} conversation changed. Check it before sending again.`;
    case "waiting-for-you": {
      const name = agentName(agent);
      return `${name ?? "The agent"} is waiting for you. Answer in the terminal.`;
    }
    case "unchecked":
      return `Couldn’t check ${who(agent)}’s screen. Try again.`;
    case "session-gone":
      return "This session has ended on your computer.";
    case "unsupported":
      return "This terminal doesn’t take typed input from the phone.";
    case "delivery-unknown":
      return unknownText(agent);
    default:
      return "Not delivered. Your draft is still here.";
  }
}

export function sendingReceipt(id: string): SendReceipt {
  return { id, state: "sending", text: "Sending…" };
}

/** A send the phone couldn't even start, with the reason it gives itself. */
export function localRefusal(id: string, reason: string): SendReceipt {
  return { id, state: "refused", text: reason };
}

/**
 * The receipt for what came back: an ack, the unknown marker (a lost route or the 10 s wait),
 * or anything else, which is treated as not delivered.
 */
export function receiptFromOutcome(
  id: string,
  outcome: unknown,
  agent: string | undefined,
): SendReceipt {
  if (outcome === INPUT_DELIVERY_UNKNOWN) return { id, state: "unknown", text: unknownText(agent) };
  if (typeof outcome === "object" && outcome !== null && "ok" in outcome) {
    if (outcome.ok === true) return { id, state: "sent", text: `Sent to ${who(agent)}` };
    const error = "error" in outcome && typeof outcome.error === "string" ? outcome.error : "";
    if (error === "delivery-unknown") return { id, state: "unknown", text: unknownText(agent) };
    return { id, state: "refused", text: refusalText(error, agent) };
  }
  return { id, state: "refused", text: refusalText(undefined, agent) };
}

/** A later outcome only changes the receipt of the send it belongs to. */
export function settleReceipt(current: SendReceipt | null, next: SendReceipt): SendReceipt | null {
  return current?.id === next.id ? next : current;
}
