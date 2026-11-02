import type { SessionInfoLoose } from "@shellbell/protocol";
import { useConnectionsStore } from "../store/connections";
import { backendLabel } from "./backends";

/** How long the phone waits for a new session to appear in the list before saying nothing. */
export const CREATION_NOTICE_WAIT_MS = 5000;

const windowKey = (session: Pick<SessionInfoLoose, "backend" | "windowId">) =>
  `${session.backend}\n${session.windowId}`;

/**
 * Where a new session went, in a sentence: a tab in a window that already had sessions
 * ("Opened a tab in Herdr · webBooks"), or a new window of its own.
 */
export function creationNotice(
  created: SessionInfoLoose,
  before: readonly Pick<SessionInfoLoose, "id" | "backend" | "windowId">[],
  catalog?: Parameters<typeof backendLabel>[1],
): string {
  const terminal = backendLabel(created.backend, catalog);
  const shared = before.some(
    (session) => session.id !== created.id && windowKey(session) === windowKey(created),
  );
  if (!shared) {
    const app = created.shownIn?.[0];
    return app && app !== terminal
      ? `Opened a new window in ${app}`
      : `Opened a new window in ${terminal}`;
  }
  return created.windowLabel
    ? `Opened a tab in ${terminal} · ${created.windowLabel}`
    : `Opened a tab in ${terminal}`;
}

/**
 * Says where a session just created from this phone opened, once the computer lists it. Quiet if
 * it doesn't appear soon: the session list shows it anyway.
 */
export function announceCreated(
  fp: string,
  sessionId: string,
  before: readonly Pick<SessionInfoLoose, "id" | "backend" | "windowId">[] = [],
): void {
  const store = useConnectionsStore;
  let done = false;
  let unsubscribe = () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tell = () => {
    if (done) return;
    const state = store.getState().byComputer[fp];
    const created = state?.sessions.find((session) => session.id === sessionId);
    if (!created) return;
    // Settled before the toast's own store update can call back in here.
    done = true;
    unsubscribe();
    if (timer) clearTimeout(timer);
    store
      .getState()
      .patch(fp, () => ({ toast: creationNotice(created, before, state?.hello?.backendCatalog) }));
  };
  tell();
  if (done) return;
  unsubscribe = store.subscribe(tell);
  timer = setTimeout(() => {
    done = true;
    unsubscribe();
  }, CREATION_NOTICE_WAIT_MS);
}
