import { clampInputHeight } from "./height";

export const REPLY_CHIP_HEIGHT = 44;
export const KEY_ROW_HEIGHT = 44;
/** The keys row stays in a short pane; it gives up some height before it gives up keys. */
export const COMPACT_KEY_ROW_HEIGHT = 40;

export function composerLayout(
  availableHeight: number | null,
  desiredInputHeight: number,
  showChips: boolean,
  accessories = true,
) {
  const desired = clampInputHeight(desiredInputHeight);
  // Reserve a small strip of terminal output. Budgets include the field's two
  // border points and the fallback Bar's two border points (glass has none).
  const terminalReserve = 32;
  const fullHeight =
    desired + 4 + 16 + (accessories ? 54 : 0) + (showChips ? REPLY_CHIP_HEIGHT + 6 : 0);
  const measured =
    availableHeight !== null && Number.isFinite(availableHeight) && availableHeight > 0;
  const compact = measured && fullHeight + terminalReserve > availableHeight;
  // 40-point compact keys still fit the reproduced 92-point pane with the fallback Bar's border.
  const verticalPadding = compact ? 2 : 8;
  const keyHeight = compact ? COMPACT_KEY_ROW_HEIGHT : KEY_ROW_HEIGHT;
  const inputHeight = compact
    ? Math.min(
        desired,
        Math.max(40, availableHeight - terminalReserve - 12 - (accessories ? keyHeight + 4 : 0)),
      )
    : desired;
  return {
    compact,
    inputHeight,
    keyHeight,
    verticalPadding,
  };
}
