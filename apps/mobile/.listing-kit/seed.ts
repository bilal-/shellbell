import { generateIdentity, type Line, type SessionInfo } from "@shellbell/protocol";
import { Dimensions } from "react-native";
import { connectionManager, type FocusedViewLease } from "../src/net/manager";
import { useComputersStore, useUiStore } from "../src/store/computers";
import { useConnectionsStore } from "../src/store/connections";
import { applySnapshotKeyed } from "../src/store/screen";

// Deliberately invalid pairing fingerprints and an RFC 2606 endpoint. No keys,
// real computer state or network connection are needed to render these screens.
const computerFp = "listing-demo-mac";
const laptopFp = "listing-demo-laptop";
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

const sessions: SessionInfo[] = [
  ["iterm2:build", "Build and test", "iterm2", "finished", "~/projects/orbit"],
  ["iterm2:server", "Development server", "iterm2", "running", "~/projects/orbit"],
  ["iterm2:logs", "Application logs", "iterm2", "running", "~/projects/orbit"],
  ["herdr:agent", "Review the changes", "herdr", "blocked", "~/projects/orbit"],
  ["tmux:shell", "Project shell", "tmux", "editing", "~/projects/website"],
].map(([id, title, backend, state, cwd], index) => ({
  id: id!,
  title: title!,
  backend: backend as SessionInfo["backend"],
  state: state as SessionInfo["state"],
  cwd,
  cols,
  rows: 30,
  windowId: backend!,
  windowNumber: 1,
  tabId: `tab-${index}`,
  tabIndex: index,
  paneIndex: 0,
  isFocusedOnMac: index === 0,
}));

const row = (text = "", fg?: number, bold = false): Line => ({
  r: text ? [{ t: text, ...(fg === undefined ? {} : { fg }), ...(bold ? { b: true } : {}) }] : [],
});
const lines: Line[] = [
  row("orbit / main", 6, true),
  row("$ pnpm test && pnpm build", 7),
  row(),
  row(" RUN  Project checks", 6),
  row(),
  row("  PASS  account settings", 2),
  row("  PASS  project navigation", 2),
  row("  PASS  notification preferences", 2),
  row("  PASS  search and filters", 2),
  row("  PASS  keyboard shortcuts", 2),
  row("  PASS  saved views", 2),
  row(),
  row("  Test files   6 passed", 2, true),
  row("       Tests  42 passed", 2, true),
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

function seed() {
  useComputersStore.setState({
    hydrated: true,
    computers: [
      { fp: computerFp, name: "Studio Mac", accent: "emerald" },
      { fp: laptopFp, name: "Travel MacBook", accent: "blue" },
    ].map((computer) => ({
      ...computer,
      relayUrl: "wss://relay.example.com",
      pairedAt: "2026-01-01T00:00:00.000Z",
      lastSeenAt: null,
      pushEnabled: false,
    })),
  });
  for (const fp of [computerFp, laptopFp]) {
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
        agentVersion: "0.2.0",
        hostPlatform: "darwin",
        accent: fp === computerFp ? "emerald" : "blue",
        computerName: fp === computerFp ? "Studio Mac" : "Travel MacBook",
        backends: ["iterm2", "herdr", "tmux"].map((name) => ({ name, capabilities })),
      },
      sessions: fp === computerFp ? sessions : sessions.slice(0, 2),
    }));
  }
}

// This entry never starts the real manager. Input has no connection to send to.
connectionManager.start = () => {};
connectionManager.get = () => undefined;
connectionManager.claimView = (fp, sessionId): FocusedViewLease => {
  useConnectionsStore.getState().patch(fp, () => ({
    view: {
      sessionId,
      view: applySnapshotKeyed(undefined, {
        cols,
        rows: lines.length,
        cursor: { x: 2, y: lines.length - 1 },
        lines,
        scrollbackTotal: 0,
        gen: 1,
      }),
    },
  }));
  return {
    release: () => {},
    revision: () => null,
    requestOlder: () => false,
    skipOversized: () => false,
    refreshHistory: () => false,
    retryOutput: () => false,
    protectHistory: () => false,
  };
};
useComputersStore.setState({ hydrate: seed });
useUiStore.setState({
  hydrate: () =>
    useUiStore.setState({ hydrated: true, fontSize: tablet ? 20 : 13, fitWidth: true }),
});
seed();
