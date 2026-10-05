import type { SessionLabel } from "./content";

/**
 * Spec 2026-09-20 §5: a backgrounded app has no in-memory session list, so notifications cannot
 * name a session without this. ONLY titles are stored — never output, never commands. Extending
 * this store to anything else requires revisiting the privacy decision in PRIVACY.md.
 *
 * Pure on purpose: no Expo or react-native import here, so this file can be imported by node
 * tests. The kv-store-backed implementation lives in `./index.ts` as `kvTitleStorage` — that file
 * already imports Expo modules at module scope and is never imported by tests.
 */
export interface TitleStorage {
  getItemSync(key: string): string | null;
  setItemSync(key: string, value: string): void;
}

const KEY = "shellbell.sessionTitles";

type Book = Record<string, Record<string, SessionLabel>>;

function read(storage: TitleStorage): Book {
  const raw = storage.getItemSync(KEY);
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Book;
  } catch {
    // A corrupt value must not break rings. Start over rather than throw in a background task.
    return {};
  }
}

export interface SessionLike {
  id: string;
  title: string;
  backend: string;
}

/**
 * Spec §5: "cap total entries per computer." A single `sessions` message is already bounded by
 * the protocol (`z.array(...).max(500)`, `packages/protocol/src/inner.ts:95`), but that is a
 * property of the wire schema, not of this store — enforced again here so the cap holds
 * regardless of what produced the list (review Minor).
 */
const MAX_SESSIONS_PER_COMPUTER = 500;

/**
 * Replaces this computer's entry wholesale, so sessions that have gone away are evicted rather
 * than accumulating.
 */
export function saveSessionTitles(
  fp: string,
  sessions: readonly SessionLike[],
  storage: TitleStorage,
): void {
  const book = read(storage);
  const next: Record<string, SessionLabel> = {};
  for (const s of sessions.slice(0, MAX_SESSIONS_PER_COMPUTER)) {
    next[s.id] = { title: s.title, backend: s.backend };
  }
  const previous = book[fp];
  if (
    previous &&
    Object.keys(previous).length === Object.keys(next).length &&
    Object.entries(next).every(
      ([id, label]) =>
        previous[id]?.title === label.title && previous[id]?.backend === label.backend,
    )
  )
    return;
  book[fp] = next;
  storage.setItemSync(KEY, JSON.stringify(book));
}

export function lookupSessionTitle(
  fp: string,
  sessionId: string,
  storage: TitleStorage,
): SessionLabel | undefined {
  return read(storage)[fp]?.[sessionId];
}

/**
 * Spec §5 / review Minor: an unpaired computer's titles otherwise linger in `kv-store` forever.
 * Called from `settings.tsx`'s unpair handler with the remaining paired fingerprints.
 */
export function evictUnpairedComputers(pairedFps: readonly string[], storage: TitleStorage): void {
  const book = read(storage);
  const paired = new Set(pairedFps);
  const next: Book = {};
  for (const fp of Object.keys(book)) {
    if (paired.has(fp)) next[fp] = book[fp] as Record<string, SessionLabel>;
  }
  storage.setItemSync(KEY, JSON.stringify(next));
}
