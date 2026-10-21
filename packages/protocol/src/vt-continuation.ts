/**
 * Start a new, explicitly discontinuous live screen while retaining normal scrollback.
 * Write as UTF-8 bytes and await xterm's write callback BEFORE resizing. CAN aborts a partial
 * parser token; leaving alternate screen precedes DECSTR so restored attributes are reset too.
 * This is framing for a new seed, never a claim that the previous source range was complete.
 */
export const VT_CONTINUATION_PREAMBLE =
  "\x18\x1b[?1049l\x1b[!p" +
  "\x1b[?9l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1015l" +
  "\x1b]104\x07\x1b]110\x07\x1b]111\x07\x1b]112\x07" +
  "\x1b[0m\x1b[2J\x1b[H";
