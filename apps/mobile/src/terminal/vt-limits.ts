/** Maximum retained history rows for snapshot and raw terminal rendering. */
export const TERMINAL_BUFFER_LIMIT = 10_000;

/** Shared native/WebView limits; retained history, seed and tail share the checkpoint budget. */
export const VT_CHECKPOINT_BYTES = 4 * 1024 * 1024;
export const VT_HISTORY_BYTES = (5 * 1024 * 1024) / 2;
export const VT_MESSAGE_BYTES = 256 * 1024;
