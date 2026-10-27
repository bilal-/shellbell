import {
  CONVERSATION_FEATURE,
  type ConversationWireEntry,
  generateIdentity,
  type Line,
  type SessionInfo,
} from "@shellbell/protocol";
import { Dimensions } from "react-native";
import { connectionManager, type FocusedViewLease } from "../src/net/manager";
import { useComputersStore, useUiStore } from "../src/store/computers";
import { useConnectionsStore } from "../src/store/connections";

// Deliberately invalid pairing fingerprints and an RFC 2606 endpoint. No keys,
// real computer state or network connection are needed to render these screens.
const computerFp = "listing-demo-mac";
const laptopFp = "listing-demo-laptop";
const linuxFp = "listing-demo-linux";
const tablet = Dimensions.get("window").width >= 600;
const cols = tablet ? 88 : 48;
const identityStorage: typeof import("../src/identity/keys") = require("../src/identity/keys");
Object.assign(identityStorage, {
  loadOrCreateIdentity: async () => ({ identity: generateIdentity(), fp: "listing-demo-phone" }),
});
// Simulators can report the Mac keyboard as attached. Capture the touch-only
// phone/tablet presentation, with its normal software keyboard controls.
Object.assign(require("../src/input/useHardwareKeyboard"), {
  useHardwareKeyboard: () => false,
});
// This offline fixture has no private data. Model a device without a passcode
// rather than requiring simulator authentication to reach the synthetic screens.
const localAuthentication: typeof import("expo-local-authentication") = require("expo-local-authentication");
Object.assign(localAuthentication, {
  getEnrolledLevelAsync: async () => localAuthentication.SecurityLevel.NONE,
  supportedAuthenticationTypesAsync: async () => [],
});
const capabilities = {
  subscribe: true,
  prompts: true,
  createSession: true,
  focus: true,
  history: true,
  absoluteLines: true,
  terminalInput: true,
  terminalPaste: true,
};

const minute = 60_000;
const now = Date.now();
interface Demo {
  id: string;
  title: string;
  backend: SessionInfo["backend"];
  state: SessionInfo["state"];
  cwd: string;
  window: string;
  project?: string;
  agent?: { kind: string; task: string; reportsState?: true };
  since?: number;
  shownIn?: string[];
}
const demo: Demo[] = [
  {
    id: "herdr:claude",
    title: "orbit",
    backend: "herdr",
    state: "running",
    cwd: "~/projects/orbit",
    window: "orbit",
    project: "orbit",
    agent: { kind: "claude", task: "Add rate limiting to the API", reportsState: true },
    since: 4,
    shownIn: ["Ghostty"],
  },
  {
    id: "herdr:agy",
    title: "billing",
    backend: "herdr",
    state: "blocked",
    cwd: "~/projects/billing",
    window: "billing",
    project: "billing",
    agent: { kind: "agy", task: "Write the invoice migration", reportsState: true },
    since: 1,
    shownIn: ["Ghostty"],
  },
  {
    id: "herdr:gemini",
    title: "docs",
    backend: "herdr",
    state: "running",
    cwd: "~/projects/docs",
    window: "docs",
    project: "docs",
    agent: { kind: "gemini", task: "Update the setup guide", reportsState: true },
    since: 12,
    shownIn: ["Ghostty"],
  },
  {
    id: "herdr:codex",
    title: "orbit-web",
    backend: "herdr",
    state: "finished",
    cwd: "~/projects/orbit-web",
    window: "orbit-web",
    project: "orbit-web",
    agent: { kind: "codex", task: "Fix the flaky checkout test", reportsState: true },
    since: 25,
    shownIn: ["Ghostty"],
  },
  {
    id: "herdr:opencode",
    title: "infra",
    backend: "herdr",
    state: "finished",
    cwd: "~/projects/infra",
    window: "infra",
    project: "infra",
    agent: { kind: "opencode", task: "Tidy the Terraform modules", reportsState: true },
    since: 70,
    shownIn: ["Ghostty"],
  },
  {
    id: "herdr:cursor",
    title: "design-system",
    backend: "herdr",
    state: "running",
    cwd: "~/projects/design-system",
    window: "design-system",
    project: "design-system",
    agent: { kind: "cursor", task: "Add dark mode tokens", reportsState: true },
    since: 2,
    shownIn: ["Ghostty"],
  },
  {
    id: "tmux:build",
    title: "build",
    backend: "tmux",
    state: "finished",
    cwd: "~/projects/orbit",
    window: "orbit",
    shownIn: ["Ghostty"],
  },
  {
    id: "tmux:server",
    title: "dev server",
    backend: "tmux",
    state: "running",
    cwd: "~/projects/orbit",
    window: "orbit",
    shownIn: ["Ghostty"],
  },
  {
    id: "iterm2:mobile",
    title: "mobile",
    backend: "iterm2",
    state: "finished",
    cwd: "~/projects/mobile",
    window: "Window 1",
    project: "mobile",
    agent: { kind: "claude", task: "Review the release notes" },
    since: 50,
  },
  {
    id: "iterm2:logs",
    title: "logs",
    backend: "iterm2",
    state: "running",
    cwd: "~/projects/mobile",
    window: "Window 1",
  },
];
const sessions: SessionInfo[] = demo.map((s, index) => ({
  id: s.id,
  title: s.title,
  backend: s.backend,
  state: s.state,
  cwd: s.cwd,
  cols,
  rows: 30,
  windowId: `${s.backend}:${s.window}`,
  windowNumber: 1,
  windowLabel: s.window,
  tabId: `tab-${index}`,
  tabIndex: index,
  paneIndex: 0,
  isFocusedOnMac: index === 0,
  ...(s.project ? { project: s.project } : {}),
  ...(s.agent ? { agent: s.agent } : {}),
  ...(s.since !== undefined
    ? { stateSince: now - s.since * minute, activeAt: now - s.since * minute }
    : {}),
  ...(s.shownIn ? { shownIn: s.shownIn } : {}),
}));
const linuxSessions: SessionInfo[] = [
  {
    ...sessions[6]!,
    id: "tmux:deploy",
    title: "deploy",
    cwd: "~/services/api",
    windowId: "tmux:api",
    windowLabel: "api",
    shownIn: undefined,
  },
  {
    ...sessions[0]!,
    id: "tmux:claude",
    backend: "tmux",
    title: "api",
    cwd: "~/services/api",
    windowId: "tmux:api",
    windowLabel: "api",
    project: "api",
    agent: { kind: "claude", task: "Investigate slow queries" },
    shownIn: undefined,
  },
];

const row = (text = "", fg?: number, bold = false): Line => ({
  r: text ? [{ t: text, ...(fg === undefined ? {} : { fg }), ...(bold ? { b: true } : {}) }] : [],
});
const build: Line[] = [
  row("orbit / main", 6, true),
  row("$ pnpm test && pnpm build", 7),
  row(),
  row(" RUN  Project checks", 6),
  row(),
  row("  PASS  rate limiter", 2),
  row("  PASS  account settings", 2),
  row("  PASS  project navigation", 2),
  row("  PASS  notification preferences", 2),
  row("  PASS  search and filters", 2),
  row("  PASS  saved views", 2),
  row(),
  row("  Test files   6 passed", 2, true),
  row("       Tests  54 passed", 2, true),
  row("    Duration  2.8s", 7),
  row(),
  row(" BUILD  Production assets", 6),
  row(),
  row("  Compiling application...", 7),
  row("  Checking types...", 7),
  row("  Generating static pages...", 7),
  row(),
  row("  dist/index.html        1.2 kB", 7),
  row("  dist/assets/app.css   12.4 kB", 7),
  row("  dist/assets/app.js    86.1 kB", 7),
  row(),
  row("  Build complete in 1.4s", 2, true),
  row(),
  row("orbit / main", 6, true),
  row("$ ", 2),
];
const agentWork: Line[] = [
  row(" > Check which docs pages mention Homebrew", 7, true),
  row(),
  row(' ● SearchText "brew install" in docs', 2),
  row("     docs/setup.md:14", 7),
  row("     docs/upgrade.md:31", 7),
  row(),
  row(" ✦ Two pages. Both assume macOS, so Linux", 4),
  row("   users have no install steps yet.", 4),
  row(),
  row(" > Update the setup guide for Linux", 7, true),
  row(),
  row(" ✦ I'll add a Linux section next to the macOS", 4),
  row("   steps and check each command.", 4),
  row(),
  row(" ● ReadFile docs/setup.md", 2),
  row(" ● ReadFile docs/install-linux.md", 2),
  row(" ● Edit docs/setup.md  +18 -6", 2),
  row("     ## Install on Linux", 7),
  row("     curl -fsSL example.com/install.sh | sh", 7),
  row("     systemctl --user enable orbit", 7),
  row(" ● Shell npm run docs:check", 2),
  row("     12 pages checked, 0 broken links", 7),
  row(),
  row(" ✦ The guide covers Ubuntu and Fedora now.", 4),
  row("   Checking the screenshots section next.", 4),
  row(),
  row(" ✦ Working (34s, esc to interrupt)", 6),
  row(),
  row(" > ", 7),
];
const agentPrompt: Line[] = [
  row(" > How do orders map to invoices today?", 7, true),
  row(),
  row(" ● ReadFile src/billing/orders.ts", 2),
  row(" ● ReadFile db/schema.sql", 2),
  row(),
  row(" ✦ Each paid order becomes one invoice, but", 4),
  row("   invoices are computed on the fly. Nothing", 4),
  row("   stores them, so totals can drift when", 4),
  row("   prices change.", 4),
  row(),
  row(" > Write the invoice migration", 7, true),
  row(),
  row(" ✦ I'll add the invoices table and backfill", 4),
  row("   it from existing orders.", 4),
  row(),
  row(" ● Write db/migrations/0042_invoices.sql", 2),
  row("     CREATE TABLE invoices (", 7),
  row("       id uuid PRIMARY KEY,", 7),
  row("       order_id uuid NOT NULL,", 7),
  row("       total_cents integer NOT NULL,", 7),
  row("       issued_at timestamptz NOT NULL", 7),
  row("     );", 7),
  row(),
  row(" Allow writing db/migrations/0042_invoices.sql?", 3, true),
  row(),
  row(" ❯ 1. Yes", 6, true),
  row("   2. Yes, and allow edits this session", 7),
  row("   3. No, say what to do instead (esc)", 7),
];
const screens: Record<string, Line[]> = {
  "herdr:agy": agentPrompt,
  "herdr:gemini": agentWork,
};

let entryId = 0;
const entry = (
  kind: ConversationWireEntry["kind"],
  text: string,
  detail?: string,
): ConversationWireEntry => ({
  id: `demo-entry-${String(entryId++).padStart(11, "0")}`,
  kind,
  text,
  ...(detail ? { detail, collapsed: true } : {}),
});
const conversation: ConversationWireEntry[] = [
  entry("user", "Why do some API clients get timeouts during the nightly sync?"),
  entry("tool-call", 'Grep · "timeout" in src/server', "6 matches"),
  entry("tool-call", "Read · src/server/sync.ts"),
  entry(
    "assistant",
    "The nightly sync sends about 900 requests a second with no limit, so other clients queue behind it until they time out.",
  ),
  entry(
    "user",
    "Add rate limiting to the public API. Keep the limits in config so ops can change them.",
  ),
  entry(
    "assistant",
    "I'll add a token bucket limiter as middleware, read the limits from `config/limits.ts`, and return 429 with a Retry-After header.",
  ),
  entry("tool-call", "Read · src/server/app.ts"),
  entry("tool-call", "Write · src/server/middleware/rate-limit.ts", "+64 lines"),
  entry("tool-call", "Edit · config/limits.ts", "+8 -1"),
  entry("tool-call", "Bash · pnpm test rate-limit", "12 passed"),
  entry(
    "assistant",
    "Done. Requests over the limit now get **429 Too Many Requests** with a `Retry-After` header, and the 12 new tests pass.\n\nWant per-key limits for API tokens too?",
  ),
];

function seed() {
  useComputersStore.setState({
    hydrated: true,
    computers: [
      { fp: computerFp, name: "Studio Mac", accent: "emerald" },
      { fp: laptopFp, name: "Travel MacBook", accent: "blue" },
      { fp: linuxFp, name: "Build server", accent: "amber" },
    ].map((computer) => ({
      ...computer,
      relayUrl: "wss://relay.example.com",
      pairedAt: "2026-01-01T00:00:00.000Z",
      lastSeenAt: null,
      pushEnabled: false,
    })),
  });
  for (const fp of [computerFp, laptopFp, linuxFp]) {
    const linux = fp === linuxFp;
    useConnectionsStore.getState().patch(fp, () => ({
      status: "online",
      agentOnline: true,
      transport: {
        route: "direct",
        ready: true,
        phase: "direct",
        retryPending: false,
        lastFailure: null,
      },
      hello: {
        type: "hello",
        agentVersion: "0.12.0",
        hostPlatform: linux ? "linux" : "darwin",
        accent: fp === computerFp ? "emerald" : fp === laptopFp ? "blue" : "amber",
        computerName:
          fp === computerFp ? "Studio Mac" : fp === laptopFp ? "Travel MacBook" : "Build server",
        backends: (linux ? ["tmux"] : ["herdr", "tmux", "iterm2"]).map((name) => ({
          name,
          capabilities,
        })),
        conversationEnabled: true,
        features: [CONVERSATION_FEATURE],
      },
      sessions: fp === computerFp ? sessions : linux ? linuxSessions : sessions.slice(8),
      sessionsComplete: true,
    }));
  }
}

const lease = (): FocusedViewLease => ({
  release: () => {},
  revision: () => null,
  conversationRevision: () => null,
  setConversation: () => {},
  requestOlderConversation: () => false,
  refreshConversation: () => false,
  requestOlder: () => false,
  skipOversized: () => false,
  refreshHistory: () => false,
  retryOutput: () => false,
  protectHistory: () => false,
  setRawStream: () => {},
  rendererError: () => {},
  rendererReady: () => {},
});

// This entry never starts the real manager. Input has no connection to send to; the Direct
// row's measurements come from this stand-in connection.
connectionManager.start = () => {};
connectionManager.get = (() => ({
  routeStats: async () => ({ path: "local", rttMs: 18 }),
  transportDiagnostics: { directSetupMs: 1200 },
})) as unknown as typeof connectionManager.get;
connectionManager.claimView = (fp, sessionId): FocusedViewLease => {
  const lines = screens[sessionId] ?? build;
  useConnectionsStore.getState().patch(fp, () => ({
    boundedView: {
      sessionId,
      snapshot: {
        status: "live",
        historyStatus: "end",
        screen: {
          cols,
          rows: lines.length,
          cursor: { x: 2, y: lines.length - 1 },
          lines,
          scrollbackTotal: 0,
          gen: 1,
        },
      },
    },
    ...(sessionId === "herdr:claude"
      ? {
          conversationView: {
            sessionId,
            subscriptionId: "demo-subscription-000000",
            snapshot: {
              state: "ready",
              entries: conversation,
              history: "complete",
              historyStatus: "idle",
              canRequestOlder: false,
              caughtUp: true,
              notice: null,
              reason: null,
            },
          },
        }
      : {}),
  }));
  return lease();
};
useComputersStore.setState({ hydrate: seed });
useUiStore.setState({
  hydrate: () =>
    useUiStore.setState({ hydrated: true, fontSize: tablet ? 20 : 13, fitWidth: true }),
});
seed();
