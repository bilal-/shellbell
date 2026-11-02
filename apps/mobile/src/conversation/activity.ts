import { agentName } from "../input/agentPrompt";
import type { AgentStatus } from "./agentStatus";
import { formatElapsed } from "./agentStatus";

/** The bar never says working without something changing within this long. */
export const ACTIVITY_FRESH_MS = 5000;

export type ActivityBarState =
  | { readonly kind: "waiting" }
  | {
      readonly kind: "working";
      readonly label: string;
      /** The ticking time, such as `12s`; `null` when nothing says when the work started. */
      readonly elapsed: string | null;
      readonly detail: string | null;
    };

export interface ActivityInput {
  readonly agentKind: string | undefined;
  readonly sessionState: string | undefined;
  readonly waiting: boolean;
  /** A password prompt is on screen: nothing read from the screen is shown. */
  readonly secret: boolean;
  readonly status: AgentStatus | null;
  /** Phone time when `status` was last read with a new value. */
  readonly statusAt: number | null;
  /** Phone time when the screen or the computer's `activeAt` last changed. */
  readonly lastActivityAt: number | null;
  /** Phone time the session has been running since, while it is. */
  readonly runningSince: number | null;
  readonly now: number;
}

/**
 * What the bar above the composer shows: the agent's own status line with a timer that ticks on
 * the phone between screen updates; else "Claude is working" from the session's state; waiting
 * when the agent waits for you; nothing when it is idle or nothing changed in the last 5 s.
 */
export function activityBar(input: ActivityInput): ActivityBarState | null {
  if (input.secret) return null;
  if (input.waiting) return { kind: "waiting" };
  const fresh =
    input.lastActivityAt !== null && input.now - input.lastActivityAt <= ACTIVITY_FRESH_MS;
  if (!fresh) return null;
  const since =
    input.runningSince !== null ? formatElapsed((input.now - input.runningSince) / 1000) : null;
  if (input.status) {
    const ticked =
      input.status.seconds !== null && input.statusAt !== null
        ? formatElapsed(input.status.seconds + Math.max(0, input.now - input.statusAt) / 1000)
        : since;
    return {
      kind: "working",
      label: input.status.label,
      elapsed: ticked,
      detail: input.status.detail,
    };
  }
  if (input.sessionState !== "running") return null;
  return {
    kind: "working",
    label: `${agentName(input.agentKind) ?? "The agent"} is working`,
    elapsed: since,
    detail: null,
  };
}
