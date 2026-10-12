import type { NavTarget } from "./routing";

export interface SessionOpenerDeps {
  pairedFps(): string[];
  navigate(path: string): void;
  push(path: string): void;
  isSessionCurrent(computerFp: string, sessionId: string): boolean;
  sessionId(route: string): string;
}

const RETRY_MS = 500;
const ATTEMPTS = 20;

/**
 * Spec 10.8: open the computer immediately, then the session once `sessions` has actually arrived
 * and contains it. If it never arrives (a session that ended while the phone was away), stay on
 * the sessions list — a push is a hint, never an instruction. A pending session open belongs to
 * the computer screen it opened; leaving that screen retires it, so it never pulls the user back.
 */
export function createSessionOpener(deps: SessionOpenerDeps) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let home: string | null = null;
  const cancel = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    home = null;
  };
  return {
    /** Cancellable so a second tap (or an unmount) cannot leave a chain of timers running (C8). */
    cancel,
    open(t: NavTarget): void {
      cancel();
      if (!deps.pairedFps().includes(t.computerFp)) return;
      const computer = `/c/${t.computerFp}`;
      // M3: `navigate` (not `push`) so repeated ring taps on the same computer reuse the existing
      // screen instead of stacking duplicates that each need their own Back.
      deps.navigate(computer);
      const route = t.sessionRoute;
      if (route === null) return;
      const sessionId = deps.sessionId(route);
      home = computer;
      let attempts = 0;
      const tryOpen = () => {
        timer = null;
        if (!deps.pairedFps().includes(t.computerFp)) return cancel();
        if (deps.isSessionCurrent(t.computerFp, sessionId)) {
          home = null;
          deps.push(`${computer}/s/${route}`);
          return;
        }
        attempts += 1;
        if (attempts < ATTEMPTS) timer = setTimeout(tryOpen, RETRY_MS);
        else home = null;
      };
      tryOpen();
    },
    /** Call whenever the visible route changes. */
    routeChanged(pathname: string): void {
      if (home !== null && pathname !== home) cancel();
    },
  };
}
