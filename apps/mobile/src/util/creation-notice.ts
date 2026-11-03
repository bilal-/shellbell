import type { SessionInfoLoose, SessionPlacement } from "@shellbell/protocol";
import { useConnectionsStore } from "../store/connections";
import { backendLabel } from "./backends";

/** How long the phone waits for a new session to appear in the list before saying nothing. */
export const CREATION_NOTICE_WAIT_MS = 5000;

const windowKey = (session: Pick<SessionInfoLoose, "backend" | "windowId">) =>
  `${session.backend}\n${session.windowId}`;

/**
 * Where a new session went, in a sentence, from where the computer says it opened: a tab beside
 * sessions in a window already listed ("Opened a tab in Herdr · webBooks"), a tab in a desktop
 * app's open window, a new window of its own, or a split beside the session it came from.
 */
export function creationNotice(
  created: SessionInfoLoose,
  { opened, openedIn }: { readonly opened: SessionPlacement; readonly openedIn?: string },
  before: readonly Pick<SessionInfoLoose, "id" | "backend" | "windowId">[],
  catalog?: Parameters<typeof backendLabel>[1],
): string {
  const terminal = backendLabel(created.backend, catalog);
  if (opened === "split") return `Opened a split pane in ${terminal}`;
  // The app the computer opened it in; a Herdr attach client isn't listed as showing it.
  const app = openedIn ?? created.shownIn?.[0];
  const shown = app && app !== terminal ? app : terminal;
  if (opened === "window") return `Opened a new window in ${shown}`;
  // A tab in a window that already had sessions is the terminal's own tab; otherwise the app
  // that shows the new session added it to its window.
  const shared = before.some(
    (session) => session.id !== created.id && windowKey(session) === windowKey(created),
  );
  if (!shared) return `Opened a tab in ${shown}`;
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
  before: readonly Pick<SessionInfoLoose, "id" | "backend" | "windowId">[] = [],
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
      toast: creationNotice(listed, { opened, openedIn }, before, state?.hello?.backendCatalog),
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
