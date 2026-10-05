import Storage from "expo-sqlite/kv-store";
import { create } from "zustand";

export interface Computer {
  fp: string;
  name: string;
  accent: string;
  relayUrl: string;
  pairedAt: string;
  pairingId?: string;
  lastSeenAt: string | null;
  pushEnabled: boolean;
  /** Durable unpair tombstone: never reconnect until cleanup finishes and removes the record. */
  removing?: boolean;
}

const KEY = "shellbell.computers.v1";
const UI_KEY = "shellbell.ui.v1";

interface ComputersState {
  computers: Computer[];
  hydrated: boolean;
  hydrate: () => void;
  add: (c: Computer) => void;
  remove: (fp: string) => void;
  update: (fp: string, patch: Partial<Computer>) => void;
}

function persist(list: Computer[]) {
  Storage.setItemSync(KEY, JSON.stringify(list));
}

export const useComputersStore = create<ComputersState>((set, get) => ({
  computers: [],
  hydrated: false,
  hydrate: () => {
    const raw = Storage.getItemSync(KEY);
    set({ computers: raw ? (JSON.parse(raw) as Computer[]) : [], hydrated: true });
  },
  add: (c) => {
    if (get().computers.some((existing) => existing.fp === c.fp && existing.removing))
      throw new Error("Finish unpairing before replacing this computer");
    const list = [...get().computers.filter((x) => x.fp !== c.fp), c];
    persist(list);
    set({ computers: list });
  },
  remove: (fp) => {
    const list = get().computers.filter((x) => x.fp !== fp);
    persist(list);
    set({ computers: list });
  },
  update: (fp, patch) => {
    const list = get().computers.map((x) => (x.fp === fp ? { ...x, ...patch } : x));
    persist(list);
    set({ computers: list });
  },
}));

interface UiPersisted {
  fontSize: number;
  fitWidth: boolean;
  rawModeBySession: Record<string, boolean>;
}

interface UiState extends UiPersisted {
  hydrated: boolean;
  hydrate: () => void;
  /** `persist: false` (the pinch gesture's `onUpdate`, review I5) updates state only; the
   *  caller must follow up with `commitFontSize()` once the gesture ends. */
  setFontSize: (n: number, opts?: { persist?: boolean }) => void;
  /** Writes the current font size to storage. Debounced-in-effect by the pinch's `onEnd` (a
   *  gesture only ends once), and called unconditionally by the settings stepper. */
  commitFontSize: () => void;
  setFitWidth: (b: boolean) => void;
  setRawMode: (sid: string, b: boolean) => void;
}

function persistUi(s: UiPersisted) {
  Storage.setItemSync(
    UI_KEY,
    JSON.stringify({
      fontSize: s.fontSize,
      fitWidth: s.fitWidth,
      rawModeBySession: s.rawModeBySession,
    }),
  );
}

export const MIN_FONT_SIZE = 5;
export const MAX_FONT_SIZE = 24;
const UI_DEFAULTS: UiPersisted = { fontSize: 12, fitWidth: false, rawModeBySession: {} };

export const useUiStore = create<UiState>((set, get) => ({
  ...UI_DEFAULTS,
  // M13: reading SQLite at module evaluation opened it synchronously during cold start, before
  // the splash screen even hid. `hydrate()` is called from the root layout's mount effect
  // instead, alongside the computers store's own `hydrate()`.
  hydrated: false,
  hydrate: () => {
    const raw = Storage.getItemSync(UI_KEY);
    const init = raw ? (JSON.parse(raw) as Partial<UiPersisted>) : {};
    set({
      fontSize: init.fontSize ?? UI_DEFAULTS.fontSize,
      fitWidth: init.fitWidth ?? UI_DEFAULTS.fitWidth,
      rawModeBySession: init.rawModeBySession ?? UI_DEFAULTS.rawModeBySession,
      hydrated: true,
    });
  },
  setFontSize: (n, opts) => {
    set({ fontSize: Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, n)) });
    if (opts?.persist !== false) persistUi(get());
  },
  commitFontSize: () => persistUi(get()),
  setFitWidth: (b) => {
    set({ fitWidth: b });
    persistUi(get());
  },
  setRawMode: (sid, b) => {
    set({ rawModeBySession: { ...get().rawModeBySession, [sid]: b } });
    persistUi(get());
  },
}));
