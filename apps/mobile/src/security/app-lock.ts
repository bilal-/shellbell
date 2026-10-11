import Storage from "expo-sqlite/kv-store";
import { create } from "zustand";
import { setControlLocked } from "./control-lock";
import { setScreenHidden } from "./screen-hidden";

const KEY = "shellbell.app-lock.v1";

/** "Immediately", 1, 5 and 15 minutes in the background. */
export const LOCK_DELAYS = [0, 60_000, 300_000, 900_000] as const;
export type LockDelay = (typeof LOCK_DELAYS)[number];

export interface LockSettings {
  enabled: boolean;
  delayMs: LockDelay;
}

export const LOCK_DEFAULTS: LockSettings = { enabled: true, delayMs: 60_000 };

/** Fails closed: only an explicit, well-formed `enabled: false` turns the lock off. */
export function readLockSettings(): LockSettings {
  try {
    const raw = Storage.getItemSync(KEY);
    if (!raw) return LOCK_DEFAULTS;
    const saved = JSON.parse(raw) as { enabled?: unknown; delayMs?: unknown } | null;
    return {
      enabled: saved?.enabled !== false,
      delayMs: LOCK_DELAYS.includes(saved?.delayMs as LockDelay)
        ? (saved?.delayMs as LockDelay)
        : LOCK_DEFAULTS.delayMs,
    };
  } catch {
    return LOCK_DEFAULTS;
  }
}

/** A clock moved backwards while the app was away counts as long enough. */
export function lockAfterAway(awayMs: number, delayMs: number): boolean {
  return awayMs < 0 || awayMs >= delayMs;
}

interface AppLockState extends LockSettings {
  hydrated: boolean;
  /** The lock screen is up; terminal control is refused until it is dismissed. */
  locked: boolean;
  /** The app is away or switching, so the app-switcher snapshot must not show terminals. */
  covered: boolean;
  /**
   * When the app last left for the background, or null once that time away is settled. Kept in
   * memory, not saved: Android's Back closes the screen but keeps JavaScript, so a reopened
   * screen's gate reads it to apply the chosen delay, while a fresh start has none and locks.
   */
  awaySince: number | null;
  hydrate: () => LockSettings;
  setEnabled: (enabled: boolean) => void;
  setDelay: (delayMs: LockDelay) => void;
  lock: () => void;
  unlock: () => void;
  cover: (covered: boolean) => void;
  setAwaySince: (at: number | null) => void;
}

function persist({ enabled, delayMs }: LockSettings) {
  Storage.setItemSync(KEY, JSON.stringify({ enabled, delayMs }));
}

// Locked until the gate has read the saved choice and checked the device, so nothing that runs
// earlier in startup (deep links, restored routes) can send input first.
export const useAppLock = create<AppLockState>((set, get) => ({
  ...LOCK_DEFAULTS,
  hydrated: false,
  locked: true,
  covered: false,
  awaySince: null,
  hydrate: () => {
    const settings = readLockSettings();
    set({ ...settings, hydrated: true });
    return settings;
  },
  setEnabled: (enabled) => {
    set({ enabled, ...(!enabled && { locked: false }) });
    persist(get());
  },
  setDelay: (delayMs) => {
    set({ delayMs });
    persist(get());
  },
  lock: () => set({ locked: true }),
  unlock: () => set({ locked: false }),
  cover: (covered) => set({ covered }),
  setAwaySince: (awaySince) => set({ awaySince }),
}));

setControlLocked(true);
setScreenHidden(true);
useAppLock.subscribe((s) => {
  setControlLocked(s.locked);
  setScreenHidden(s.locked || s.covered);
});
