/**
 * Hand-written Herdr JSON socket response shapes. No upstream schema or generated
 * implementation is vendored; current behavior is described in
 * docs/architecture/computer-agent.md#adapter-details.
 */
import type { AgentState } from "../types.js";

/** Herdr's `AgentStatus` is byte-for-byte our `AgentState`; keep one definition. */
export type AgentStatus = AgentState;

export interface Pong {
  type: "pong";
  version?: string;
  /** Herdr's BINARY client/server generation. Never a JSON-API floor — see . */
  protocol?: number;
  capabilities?: Record<string, unknown> | null;
}

export interface PaneScroll {
  offset_from_bottom?: number;
  max_offset_from_bottom?: number;
  viewport_rows?: number;
}

/** research §2 `PaneInfo`: pane_id, terminal_id, workspace_id, tab_id, focused, agent_status,
 * revision are required; the rest are optional. */
export interface PaneInfo {
  pane_id: string;
  terminal_id: string;
  workspace_id: string;
  tab_id: string;
  focused: boolean;
  agent_status: string;
  revision: number;
  label?: string;
  title?: string;
  cwd?: string;
  foreground_cwd?: string;
  agent?: string;
  display_agent?: string;
  terminal_title?: string;
  terminal_title_stripped?: string;
  scroll?: PaneScroll;
}

/** research §2 `AgentInfo` = `PaneInfo` + these. */
export interface AgentInfo extends PaneInfo {
  name?: string;
  interactive_ready?: boolean;
  launch_pending?: boolean;
  screen_detection_skipped?: boolean;
  state_change_seq?: number;
}

export interface WorkspaceInfo {
  workspace_id: string;
  number: number;
  label: string;
  focused: boolean;
  pane_count?: number;
  tab_count?: number;
  active_tab_id?: string;
  agent_status?: string;
}

export interface TabInfo {
  tab_id: string;
  workspace_id: string;
  number: number;
  label: string;
  focused: boolean;
  pane_count?: number;
  agent_status?: string;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PaneLayoutSnapshot {
  workspace_id: string;
  tab_id: string;
  zoomed?: boolean;
  area?: Rect;
  focused_pane_id?: string | null;
  panes: { pane_id: string; focused?: boolean; rect: Rect }[];
  splits?: { id?: string; direction?: string; ratio?: number; rect?: Rect }[];
}

export interface SessionSnapshot {
  version: string;
  protocol: number;
  focused_workspace_id?: string | null;
  focused_tab_id?: string | null;
  focused_pane_id?: string | null;
  workspaces: WorkspaceInfo[];
  tabs: TabInfo[];
  panes: PaneInfo[];
  layouts: PaneLayoutSnapshot[];
  agents: AgentInfo[];
}

export interface SessionSnapshotResult {
  type: "session_snapshot";
  snapshot: SessionSnapshot;
}

export interface PaneReadResult {
  type: "pane_read";
  read: {
    pane_id: string;
    workspace_id?: string;
    tab_id?: string;
    source: string;
    format: string;
    /** ⚠ always 0 on `pane.read` (hard-coded upstream) — never usable as a change cursor. */
    revision: number;
    truncated: boolean;
    text: string;
  };
}

export interface PaneInfoResult {
  type: "pane_info";
  pane: PaneInfo;
}

export interface TabCreatedResult {
  type: "tab_created";
  tab: TabInfo;
  root_pane: PaneInfo;
}

export type WorkspaceCreatedResult = Omit<TabCreatedResult, "type"> & {
  type: "workspace_created";
  workspace: WorkspaceInfo;
};

/** A streamed event line: lifecycle events are snake_case, subscription events are dotted. */
export interface HerdrEvent {
  event: string;
  data: Record<string, unknown>;
}

/** One entry of `events.subscribe`'s `subscriptions` array (research §2). */
export interface HerdrSubscription {
  type: string;
  pane_id?: string;
  agent_status?: string;
}
