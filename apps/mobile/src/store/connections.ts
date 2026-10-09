import type {
  InnerMessageLooseOf,
  ScreenSnapshot,
  SessionInfoLoose,
  V2TransportState,
} from "@shellbell/protocol";
import { create } from "zustand";
import type { MobileStreamSnapshot } from "../net/mobile-screen-stream";
import type { ViewState } from "./screen";

export type Status =
  | "idle"
  | "connecting"
  | "auth"
  | "handshake"
  | "waiting-direct"
  | "online"
  | "offline"
  | "error";

/** Terminal error states: no reconnect will help until the user acts. */
export type ErrorKind =
  | "unpaired"
  | "re-pair"
  | "superseded"
  | "rejected"
  | "relay"
  | "upgrade-required"
  | "storage";

export type SessionEvent = InnerMessageLooseOf<"event">;

export interface ComputerConn {
  status: Status;
  agentOnline: boolean;
  transport?: V2TransportState;
  offlineReason?: "computer" | "relay" | "network";
  error?: ErrorKind;
  hello?: InnerMessageLooseOf<"hello">;
  sessions: SessionInfoLoose[];
  view?: { sessionId: string; view: ViewState };
  boundedView?: {
    sessionId: string;
    snapshot: MobileStreamSnapshot;
    /** Display-only last complete viewport; never passed to MobileScreenStream. */
    fallbackScreen?: Readonly<ScreenSnapshot>;
  };
  /** Oldest absolute line the agent still has, per session (from `history.oldestAvailable`). */
  oldestAvailable: Record<string, number>;
  events: Record<string, SessionEvent[]>;
  unread: Record<string, number>;
  pendingInputs: Record<string, { at: number; sessionId: string }>;
  history: string[];
  toast?: string;
}

const empty = (): ComputerConn => ({
  status: "idle",
  agentOnline: false,
  sessions: [],
  oldestAvailable: {},
  events: {},
  unread: {},
  pendingInputs: {},
  history: [],
});

interface ConnectionsState {
  byComputer: Record<string, ComputerConn>;
  read: (fp: string) => ComputerConn;
  patch: (fp: string, fn: (c: ComputerConn) => Partial<ComputerConn>) => void;
}

export const useConnectionsStore = create<ConnectionsState>((set, get) => ({
  byComputer: {},
  read: (fp) => get().byComputer[fp] ?? empty(),
  patch: (fp, fn) => {
    const cur = get().byComputer[fp] ?? empty();
    set({ byComputer: { ...get().byComputer, [fp]: { ...cur, ...fn(cur) } } });
  },
}));

export function pendingInputHooks(fp: string, sessionId: string) {
  return {
    track: (id: string) =>
      useConnectionsStore.getState().patch(fp, (state) => ({
        pendingInputs: { ...state.pendingInputs, [id]: { at: Date.now(), sessionId } },
      })),
    untrack: (id: string, toast?: string) =>
      useConnectionsStore.getState().patch(fp, (state) => ({
        pendingInputs: Object.fromEntries(
          Object.entries(state.pendingInputs).filter(([key]) => key !== id),
        ),
        ...(toast ? { toast } : {}),
      })),
  };
}
