/**
 * Shared toast copy, kept in its own dependency-free module so it can be imported both by
 * `manager.ts` (a deliberate background close, or any close with un-acked input) and by
 * `input/fireInput.ts` (a synchronous send rejection) without pulling `manager.ts`'s
 * `react-native`/`expo-sqlite` imports into a plain unit test.
 */
export const LOST_INPUT_TOAST = "Some input may not have been delivered";

/** A notification's tmux pane closed when tmux restarted; another pane now has its number. */
export const TERMINAL_REPLACED_TOAST =
  "That terminal closed when tmux restarted, so here's what's open on your computer now.";
