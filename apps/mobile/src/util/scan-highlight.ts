export interface ScanRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Expo reports view-space bounds; absent/invalid native bounds use the viewfinder instead. */
export function scanHighlight(
  bounds: { origin: { x: number; y: number }; size: { width: number; height: number } } | undefined,
  view: { width: number; height: number },
): ScanRect | null {
  if (!bounds) return null;
  const { x, y } = bounds.origin;
  const { width, height } = bounds.size;
  if (
    ![x, y, width, height, view.width, view.height].every(Number.isFinite) ||
    width <= 0 ||
    height <= 0 ||
    view.width <= 0 ||
    view.height <= 0 ||
    x + width <= 0 ||
    y + height <= 0 ||
    x >= view.width ||
    y >= view.height
  )
    return null;
  const left = Math.max(0, x - 8);
  const top = Math.max(0, y - 8);
  return {
    left,
    top,
    width: Math.min(view.width, x + width + 8) - left,
    height: Math.min(view.height, y + height + 8) - top,
  };
}
