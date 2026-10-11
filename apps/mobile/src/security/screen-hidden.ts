import { useEffect, useRef } from "react";
import { create } from "zustand";

/**
 * iOS presents one native modal at a time, so the lock screen cannot appear above another open
 * sheet. App Lock sets this while it is locked or covering the app; every other `Modal` hides
 * while it is true. Kept apart from the lock's saved settings so sheets do not depend on storage.
 */
const useHidden = create<{ hidden: boolean }>(() => ({ hidden: false }));

export const useScreenHidden = () => useHidden((s) => s.hidden);

export function setScreenHidden(hidden: boolean): void {
  if (useHidden.getState().hidden !== hidden) useHidden.setState({ hidden });
}

/**
 * Closes an open sheet as App Lock hides the app, rather than hiding it to re-present later: by
 * then its screen may be gone, and a transparent sheet over another screen would take its taps.
 * Returns whether sheets are hidden, so the sheet also steps aside in this same render.
 */
export function useCloseWhenHidden(open: boolean, close: () => void): boolean {
  const hidden = useScreenHidden();
  const latest = useRef(close);
  latest.current = close;
  useEffect(() => {
    if (open && hidden) latest.current();
  }, [open, hidden]);
  return hidden;
}
