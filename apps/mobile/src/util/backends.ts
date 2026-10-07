import type { SessionLaunchTarget } from "@shellbell/protocol";
import {
  type BackendDescriptor,
  type BackendName,
  BackendNameSchema,
  BUILTIN_BACKEND_LABELS,
  BuiltinBackendNameSchema,
  type Capabilities,
} from "@shellbell/protocol";

const LABELS = BUILTIN_BACKEND_LABELS;

const NEW_SESSION_LABELS: Record<string, string> = {
  iterm2: "New iTerm2 tab",
  tmux: "New tmux window",
  herdr: "New Herdr tab",
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

const CONNECTION_HINTS: Record<string, string> = {
  iterm2: "Open iTerm2 and enable its Python API on your computer.",
  tmux: "Start a tmux session on your computer.",
  herdr: "Install Herdr on your computer. Shellbell connects through its local API.",
};

export function sessionCreationOptions(
  backends: readonly { name: string; capabilities: { createSession: boolean } }[],
  launchableBackends: readonly string[] = [],
  catalog?: readonly BackendDescriptor[],
  launchTargets: readonly SessionLaunchTarget[] = [],
) {
  const names = [
    ...BuiltinBackendNameSchema.options,
    ...(catalog?.map((entry) => entry.name) ?? []),
  ];
  const base = [...new Set(names)].map((backend) => {
    const descriptor = catalog?.find((entry) => entry.name === backend);
    const advertised = catalog
      ? descriptor?.connected
        ? descriptor
        : undefined
      : backends.find((entry) => entry.name === backend);
    const launchable =
      !advertised && (descriptor?.launchable ?? launchableBackends.includes(backend));
    const available = advertised?.capabilities.createSession === true || launchable;
    return {
      backend,
      host: undefined as string | undefined,
      label: launchable
        ? backend === "tmux"
          ? "Start tmux session"
          : `Start ${backendLabel(backend, catalog)}`
        : BuiltinBackendNameSchema.safeParse(backend).success
          ? newSessionLabel(backend)
          : `New ${backendLabel(backend, catalog)} session`,
      available,
      detail: launchable
        ? backend === "iterm2"
          ? "Launches iTerm2 on your computer. Its Python API must be enabled."
          : `Starts ${backendLabel(backend, catalog)} on your computer.`
        : available
          ? "Runs on your computer."
          : advertised
            ? "Session creation is unavailable for this app."
            : Object.hasOwn(CONNECTION_HINTS, backend)
              ? CONNECTION_HINTS[backend]!
              : `Connect ${backendLabel(backend, catalog)} on your computer.`,
    };
  });
  return [
    ...base,
    ...launchTargets.flatMap((target) => {
      const engine = base.find((option) => option.backend === target.backend);
      if (!engine?.available || asBackendName(target.backend, catalog) === null) return [];
      return [
        {
          backend: target.backend,
          host: target.host,
          label: `${target.label} · ${backendLabel(target.backend, catalog)}`,
          available: true,
          detail: `Starts a ${backendLabel(target.backend, catalog)} session and opens it in ${target.label} on your computer.`,
        },
      ];
    }),
  ];
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
