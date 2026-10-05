import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  deriveNotificationKey,
  fingerprint,
  generateIdentity,
  openNotification,
  toBase64Url,
} from "@shellbell/protocol";
import { expect, it, vi } from "vitest";
import { Agent } from "../src/agent.js";
import { BackendRegistry } from "../src/backends/registry.js";
import { startTmuxBackend } from "../src/backends/tmux/start.js";
import { loadConfig, paths, savePairings } from "../src/config.js";
import { loadOrCreateIdentity } from "../src/identity.js";
import { createLogger } from "../src/log.js";
import { NotificationState } from "../src/notification-state.js";
import { FakeRelay } from "./fakes/fake-relay.js";
import { waitFor } from "./fakes/wait.js";

const run = promisify(execFile);

// Real tmux, isolated from the operator's server, pairings, relay and phones.
it.skipIf(process.env.SHELLBELL_TMUX_E2E !== "1")(
  "routes tmux reconnect output through Agent under a non-UTF-8 service locale",
  async () => {
    // Native services do not inherit the interactive shell's UTF-8 locale.
    vi.stubEnv("LC_ALL", "C");
    vi.stubEnv("LC_CTYPE", "C");
    vi.stubEnv("LANG", "C");
    const root = mkdtempSync(join(tmpdir(), "shellbell-tmux-notify-"));
    const socket = `sb-notify-${process.pid}-${Date.now()}`;
    const tmux = (...args: string[]) => run("tmux", ["-L", socket, ...args]);
    const log = createLogger({ stdout: false });
    const registry = new BackendRegistry(log);
    const p = paths(root);
    const { identity, fp } = loadOrCreateIdentity(p);
    const phoneIdentity = generateIdentity();
    const phoneFp = fingerprint(phoneIdentity.ed25519.pub);
    const key = new Uint8Array(32).fill(7);
    savePairings(p, [
      {
        phoneFp,
        name: "Synthetic phone",
        platform: "android",
        ed25519Pub: toBase64Url(phoneIdentity.ed25519.pub),
        x25519Pub: toBase64Url(phoneIdentity.x25519.pub),
        kPair: toBase64Url(key),
        pairedAt: new Date().toISOString(),
        lastSeenAt: null,
      },
    ]);
    const state = new NotificationState(p);
    state.enroll(phoneFp, "AAAAAAAAAAAAAAAAAAAAAA");
    const relay = new FakeRelay(fp, { features: ["notify-context-v1"] });
    let agent: Agent | undefined;
    let detector: ReturnType<typeof startTmuxBackend> | undefined;
    try {
      await relay.start();
      agent = new Agent({
        paths: p,
        config: {
          ...loadConfig(p),
          computerName: "Synthetic Mac",
          idleQuietMs: 4000,
          idleMinActiveMs: 1500,
          notifyMinCommandMs: 10000,
        },
        identity,
        fp,
        registry,
        log,
        confirm: async () => false,
        appVersion: "test",
        relayUrlOverride: relay.url,
      });
      agent.start();
      await waitFor(() => agent!.relayOnline);
      detector = startTmuxBackend({
        registry,
        log,
        retryMs: 50,
        backendOptions: { socketName: socket },
      });
      await tmux("new-session", "-d", "-s", "bootstrap", "/bin/sh");
      await vi.waitFor(async () => {
        const sessions = await registry.listSessions();
        expect(sessions).toHaveLength(1);
        expect(sessions[0]?.id).toBe("tmux:%0");
      });
      await tmux("kill-server");
      await waitFor(() => !registry.connected().some((b) => b.name === "tmux"));
      await tmux("new-session", "-d", "-s", "qa", "-n", "qa-π", "/bin/bash --noprofile --norc");
      const session = await vi.waitFor(async () => {
        const sessions = await registry.listSessions();
        expect(sessions).toHaveLength(1);
        return sessions[0]!;
      });
      // Timed reads create sustained terminal activity, not assertion timing.
      await tmux(
        "send-keys",
        "-t",
        "qa:0.0",
        "-l",
        "for i in 1 2 3 4 5; do echo 'synthetic notification probe'; read -t 1; done",
      );
      await tmux("send-keys", "-t", "qa:0.0", "Enter");
      await waitFor(
        () => relay.ctrlFromAgent.some((m) => m.type === "notify-context" || m.type === "notify"),
        12_000,
      );
      const messages = relay.ctrlFromAgent.filter(
        (m) => m.type === "notify-context" || m.type === "notify",
      );
      expect(messages).toHaveLength(1);
      const message = messages[0]!;
      expect(message.type).toBe("notify-context");
      if (message.type !== "notify-context") throw new Error("generic fallback");
      expect(message.sessionId).toBe(session.id);
      expect(message.boxes).toHaveLength(1);
      const box = message.boxes[0]!;
      const payload = openNotification(deriveNotificationKey(key, box), box);
      expect(payload.sessionId).toBe(session.id);
      expect(payload.reason).toBe("quiet");
      expect(payload.sequence).toBe("1");
      expect(payload.context.computerName).toBe("Synthetic Mac");
      expect(payload.context.sessionLabel).toContain("tmux");
      expect(payload.context.title).toContain("π");
      expect(JSON.stringify(message)).not.toContain("Synthetic Mac");
    } finally {
      agent?.stop();
      detector?.stop();
      await relay.stop();
      try {
        await registry.close();
      } finally {
        await tmux("kill-server").catch(() => undefined);
        rmSync(root, { recursive: true, force: true });
        vi.unstubAllEnvs();
      }
    }
  },
  20_000,
);
