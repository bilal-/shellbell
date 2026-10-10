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
