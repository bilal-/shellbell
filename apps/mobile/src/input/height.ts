/**
 * The input bar grows with the text instead of scrolling a single line out of sight, so a wrapped
 * command stays readable while it is being typed. It stops at three lines: past that the input
 * starts eating the terminal it exists to type into, which on a phone is most of the screen.
 *
 * `INPUT_MIN_HEIGHT` is the height the bar had when it could not grow at all, so a collapsed
 * input is pixel-identical to before.
 */
export const INPUT_LINE_HEIGHT = 20;
export const INPUT_MIN_HEIGHT = 40;
export const INPUT_MAX_HEIGHT = INPUT_MIN_HEIGHT + 2 * INPUT_LINE_HEIGHT;

/**
 * Clamps a measured content height into that range. Non-positive measurements are treated as the
 * collapsed height: `onContentSizeChange` can report 0 before the first real layout pass, and
 * honouring it would collapse the bar for a frame.
 */
export function clampInputHeight(contentHeight: number): number {
  if (!(contentHeight > 0)) return INPUT_MIN_HEIGHT;
  return Math.min(Math.max(contentHeight, INPUT_MIN_HEIGHT), INPUT_MAX_HEIGHT);
}
