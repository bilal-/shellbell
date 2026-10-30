import {
  type BackendDescriptor,
  type BackendName,
  BackendNameSchema,
  BUILTIN_BACKEND_LABELS,
  BuiltinBackendNameSchema,
  type Capabilities,
  compareWindowHosts,
  noUsableMacTerminal,
  type SessionLaunchIssue,
  type SessionLaunchTarget,
  type TerminalSetup,
} from "@shellbell/protocol";

const LABELS = BUILTIN_BACKEND_LABELS;

const NEW_SESSION_LABELS: Record<string, string> = {
  iterm2: "New iTerm2 tab",
  tmux: "New tmux session",
  herdr: "New Herdr session",
};

/** Known backend -> its display name; anything else -> the raw string. */
export function backendLabel(name: string, catalog?: readonly BackendDescriptor[]): string {
  const builtin = BuiltinBackendNameSchema.safeParse(name);
  return (
    catalog?.find((entry) => entry.name === name)?.label ??
    (builtin.success ? LABELS[builtin.data] : name)
  );
}

export function newSessionLabel(name: string, catalog?: readonly BackendDescriptor[]): string {
  return Object.hasOwn(NEW_SESSION_LABELS, name)
    ? NEW_SESSION_LABELS[name]!
    : `New ${backendLabel(name, catalog)} session`;
}

const ITERM_HINT = "Open iTerm2 and enable its Python API on your computer.";

export function sessionCreationOptions(
  backends: readonly { name: string; capabilities: { createSession: boolean } }[],
  launchableBackends: readonly string[] = [],
  catalog?: readonly BackendDescriptor[],
  launchTargets: readonly SessionLaunchTarget[] = [],
  launchIssues: readonly SessionLaunchIssue[] = [],
) {
  const names = [
    ...BuiltinBackendNameSchema.options,
    ...(catalog?.map((entry) => entry.name) ?? []),
  ];
  const engines = [...new Set(names)].map((backend) => {
    const descriptor = catalog?.find((entry) => entry.name === backend);
    const advertised = catalog
      ? descriptor?.connected
        ? descriptor
        : undefined
      : backends.find((entry) => entry.name === backend);
    const launchable =
      !advertised && (descriptor?.launchable ?? launchableBackends.includes(backend));
    const available = advertised?.capabilities.createSession === true || launchable;
    return { backend, advertised, launchable, available };
  });
  // A new iTerm2 tab is itself a window on the computer.
  const iterm = engines.find((engine) => engine.backend === "iterm2")!;
  const native = {
    backend: "iterm2",
    host: undefined as string | undefined,
    label: newSessionLabel("iterm2"),
    available: iterm.available,
    detail: iterm.launchable
      ? "Opens iTerm2 on your computer. Its Python API must be enabled."
      : iterm.available
        ? "Opens in iTerm2 on your computer."
        : iterm.advertised
          ? "Session creation is unavailable for this app."
          : ITERM_HINT,
  };
  // Every other engine is offered only in a terminal app the computer advertises, so a new
  // session never runs where only the phone can see it.
  const hosted = launchTargets
    .filter(
      (target) =>
        engines.find((engine) => engine.backend === target.backend)?.available === true &&
        asBackendName(target.backend, catalog) !== null,
    )
    .sort(
      (a, b) =>
        rank(ENGINE_ORDER, a.backend) - rank(ENGINE_ORDER, b.backend) ||
        a.backend.localeCompare(b.backend) ||
        compareWindowHosts(a.host, b.host),
    )
    .map((target) => ({
      backend: target.backend,
      host: target.host as string | undefined,
      label: `${backendLabel(target.backend, catalog)} in ${target.label}`,
      available: true,
      detail: `Opens in ${target.label} on your computer.`,
    }));
  // A backend the computer cannot open says why, instead of silently disappearing.
  const blocked = launchIssues
    .filter(
      (issue) =>
        !hosted.some((option) => option.backend === issue.backend) &&
        asBackendName(issue.backend, catalog) !== null,
    )
    .sort((a, b) => rank(ENGINE_ORDER, a.backend) - rank(ENGINE_ORDER, b.backend))
    .map((issue) => ({
      backend: issue.backend,
      host: undefined as string | undefined,
      label: newSessionLabel(issue.backend, catalog),
      available: false,
      detail: issue.reason,
    }));
  return [native, ...hosted, ...blocked];
}

/** One engine per row; desktop launch destinations belong to its next step. */
export function sessionCreationGroups(...args: Parameters<typeof sessionCreationOptions>) {
  const [backends, launchable = [], catalog, targets = []] = args;
  const options = sessionCreationOptions(...args);
  const names = [
    ...new Set([
      ...options.map((option) => option.backend),
      ...backends.map((backend) => backend.name),
      ...launchable,
      ...(catalog
        ?.filter((entry) => entry.connected || entry.launchable)
        .map((entry) => entry.name) ?? []),
    ]),
  ];
  return names
    .flatMap((name) => {
      const backend = asBackendName(name, catalog);
      if (backend === null) return [];
      const choices = options.filter((option) => option.backend === backend);
      const launches = choices
        .filter((option) => option.available)
        .filter(
          (option, index, all) => all.findIndex((other) => other.host === option.host) === index,
        )
        .map((option) => ({
          ...option,
          hostLabel:
            targets.find((target) => target.backend === backend && target.host === option.host)
              ?.label ?? backendLabel(backend, catalog),
        }));
      const capabilities =
        catalog?.find((entry) => entry.name === backend)?.capabilities ??
        backends.find((entry) => entry.name === backend)?.capabilities;
      return [
        {
          backend,
          label: backendLabel(backend, catalog),
          available: launches.length > 0,
          detail:
            launches.length === 1
              ? launches[0]!.detail
              : launches.length
                ? `Open in ${launches.map((launch) => launch.hostLabel).join(" or ")}`
                : (choices[0]?.detail ??
                  (capabilities?.createSession === false
                    ? "Session creation is unavailable for this app."
                    : "No terminal app on your computer can open this session yet.")),
          launches,
        },
      ];
    })
    .sort(
      (a, b) =>
        rank(["iterm2", ...ENGINE_ORDER], a.backend) -
          rank(["iterm2", ...ENGINE_ORDER], b.backend) || a.label.localeCompare(b.label),
    );
}

/**
 * Shown when nothing in the new session sheet can open on the computer. A new session needs a
 * window on the computer: an iTerm2 tab, or tmux or Herdr in Ghostty. A Mac with none of iTerm2,
 * tmux or Herdr is told what to install; on any other computer an update may be what's missing.
 */
export function noDesktopSessionText(setup: readonly TerminalSetup[] = []): string {
  return noUsableMacTerminal(setup)
    ? "To open new sessions from your phone, install iTerm2 on your Mac, or tmux or Herdr with Ghostty. iTerm2 is the easiest."
    : "No terminal app on your computer can show a new session yet. Install iTerm2 or Ghostty there, or update Shellbell on your computer.";
}

const ENGINE_ORDER = ["tmux", "herdr"];
function rank(order: readonly string[], name: string): number {
  const index = order.indexOf(name);
  return index === -1 ? order.length : index;
}

/**
 * The computer explains a refused or undone creation in a sentence; other failures are short
 * codes such as `failed` that the phone replaces with its own wording.
 */
export function creationErrorText(error: string | undefined): string | undefined {
  return error && /\s/.test(error) ? error : undefined;
}

/**
 * `session.create` and `session.focus` travel to the agent's *strict* parser, so only a backend the
 * shipped enum knows may be offered as an action. Unknown backends still render (label + badge);
 * they just get no "New …" entry.
 */
export function asBackendName(
  name: string,
  catalog?: readonly BackendDescriptor[],
): BackendName | null {
  const r = catalog?.some((entry) => entry.name === name)
    ? BackendNameSchema.safeParse(name)
    : BuiltinBackendNameSchema.safeParse(name);
  return r.success ? r.data : null;
}

export function activeBackends(
  hello:
    | {
        backends: readonly { name: string; capabilities: Capabilities }[];
        backendCatalog?: readonly BackendDescriptor[];
      }
    | null
    | undefined,
) {
  return hello?.backendCatalog?.filter((entry) => entry.connected) ?? hello?.backends ?? [];
}

/** a Herdr cursor is inferred from the agent's output, not a real terminal cursor. */
export function cursorIsInferred(backend: string): boolean {
  return backend === "herdr";
}

/** Session ids are "<backend>:<native id>"; the list groups by backend before window. */
export function backendOf(sessionId: string): string {
  const i = sessionId.indexOf(":");
  return i === -1 ? sessionId : sessionId.slice(0, i);
}
