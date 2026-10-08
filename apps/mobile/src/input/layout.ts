import { clampInputHeight } from "./height";

export const REPLY_CHIP_HEIGHT = 44;

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
  const verticalPadding = compact ? 4 : 8;
  const inputHeight = compact
    ? Math.min(desired, Math.max(40, availableHeight - terminalReserve - 12))
    : desired;
  return {
    compact,
    inputHeight,
    verticalPadding,
  };
}
