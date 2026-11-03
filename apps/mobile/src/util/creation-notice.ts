import type { SessionInfoLoose, SessionPlacement } from "@shellbell/protocol";
import { useConnectionsStore } from "../store/connections";
import { backendLabel } from "./backends";

/** How long the phone waits for a new session to appear in the list before saying nothing. */
export const CREATION_NOTICE_WAIT_MS = 5000;

/**
 * Where a new session went, in a sentence, from what the computer says it made: a tab in the
 * terminal's own window or workspace ("Opened a tab in Herdr · webBooks"), a tab or window that a
 * desktop app opened for it (`openedIn`), a new window of its own, or a split beside the session
 * it came from. Nothing is inferred from the phone's list, which may not have caught up yet.
 */
export function creationNotice(
  created: SessionInfoLoose,
  { opened, openedIn }: { readonly opened: SessionPlacement; readonly openedIn?: string },
  catalog?: Parameters<typeof backendLabel>[1],
): string {
  const terminal = backendLabel(created.backend, catalog);
  if (opened === "split") return `Opened a split pane in ${terminal}`;
  if (opened === "window") return `Opened a new window in ${openedIn ?? terminal}`;
  if (openedIn) return `Opened a tab in ${openedIn}`;
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
  created: {
    readonly sessionId: string;
    readonly opened?: SessionPlacement;
    readonly openedIn?: string;
  },
): void {
  const { sessionId, opened, openedIn } = created;
  // The computer says where every session it made opened; without that there's nothing to say.
  if (!opened) return;
  const store = useConnectionsStore;
  let done = false;
  let unsubscribe = () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tell = () => {
    if (done) return;
    const state = store.getState().byComputer[fp];
    const listed = state?.sessions.find((session) => session.id === sessionId);
    if (!listed) return;
    // Settled before the toast's own store update can call back in here.
    done = true;
    unsubscribe();
    if (timer) clearTimeout(timer);
    store.getState().patch(fp, () => ({
      toast: creationNotice(listed, { opened, openedIn }, state?.hello?.backendCatalog),
    }));
  };
  tell();
  if (done) return;
  unsubscribe = store.subscribe(tell);
  timer = setTimeout(() => {
    done = true;
    unsubscribe();
  }, CREATION_NOTICE_WAIT_MS);
}
