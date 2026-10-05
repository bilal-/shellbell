import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fingerprint, generateIdentity } from "@shellbell/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Agent } from "../src/agent.js";
import { HerdrClient } from "../src/backends/herdr/client.js";
import { BackendRegistry } from "../src/backends/registry.js";
import { loadConfig, paths } from "../src/config.js";
import { createLogger, safeErrorName } from "../src/log.js";
import { ScreenTracker } from "../src/screen-tracker.js";
import { FakeBackend } from "./fakes/fake-backend.js";
import { FakeHerdr } from "./fakes/fake-herdr.js";

const secret = "PRIVATE_TERMINAL_COOKIE_SENTINEL";
let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sb-log-privacy-"));
  file = join(dir, "agent.log");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("backend error logging privacy", () => {
  it("does not persist arbitrary Herdr discovery metadata", async () => {
    const server = new FakeHerdr();
    await server.start();
    try {
      server.reply("ping", () => ({ type: "pong", version: secret, protocol: secret }));
      const client = new HerdrClient({
        socketPath: server.path,
        log: createLogger({ file, stdout: false, verbose: true }),
      });
      expect(await client.ping()).toMatchObject({ version: secret });
      expect(readFileSync(file, "utf8")).not.toContain(secret);
      server.reply("ping", () => ({ type: "pong", version: "0.8.2", protocol: 20 }));
      await client.ping();
      expect(readFileSync(file, "utf8")).toContain('"version":"0.8.2"');
      expect(readFileSync(file, "utf8")).toContain('"protocol":20');
    } finally {
      await server.stop();
    }
  });
  it("keeps free-form relay error codes and messages out of logs", () => {
    const log = createLogger({ file, stdout: false });
    const identity = generateIdentity();
    const p = paths(dir);
    const agent = new Agent({
      paths: p,
      config: loadConfig(p),
      identity,
      fp: fingerprint(identity.ed25519.pub),
      registry: new BackendRegistry(log),
      log,
      confirm: async () => false,
      appVersion: "privacy-fixture",
    });
    try {
      agent.relay.emit("ctrl", { type: "error", code: secret, message: secret });
      agent.relay.emit("ctrl", { type: "error", code: "too-many-pairings", message: secret });
      const logged = readFileSync(file, "utf8");
      expect(logged).not.toContain(secret);
      expect(logged).toContain('"code":"unknown"');
      expect(logged).toContain('"code":"too-many-pairings"');
    } finally {
      agent.stop();
    }
  });
  it("retains only fixed error categories without coercing values or leaking custom names", () => {
    expect(safeErrorName(new TypeError(secret))).toBe("TypeError");
    expect(safeErrorName(Object.assign(new Error(secret), { name: "SessionGone" }))).toBe(
      "SessionGone",
    );
    expect(safeErrorName(Object.assign(new Error(secret), { name: secret }))).toBe("Error");
    expect(
      safeErrorName({
        toString: () => {
          throw new Error(secret);
        },
      }),
    ).toBe("unknown");
    expect(
      safeErrorName(
        Object.defineProperty(new Error(secret), "name", {
          get: () => {
            throw new Error(secret);
          },
        }),
      ),
    ).toBe("unknown");
    expect(safeErrorName(secret)).toBe("unknown");
    expect(safeErrorName(null)).toBe("unknown");
  });
  for (const [label, error] of [
    ["thrown string", secret],
    ["custom error name", Object.assign(new Error(secret), { name: secret })],
    ["coercible object", { toString: () => secret }],
  ] as const) {
    it(`does not persist ${label} from registry event listeners`, () => {
      const backend = new FakeBackend();
      const registry = new BackendRegistry(createLogger({ file, stdout: false }));
      registry.add(backend);
      registry.on(() => {
        throw error;
      });
      let delivered = false;
      registry.on(() => {
        delivered = true;
      });
      backend.emit({ type: "screen-changed", sessionId: "S" });
      expect(delivered).toBe(true);
      expect(readFileSync(file, "utf8")).not.toContain(secret);
    });
    it(`does not persist ${label} from registry failures`, async () => {
      const backend = new FakeBackend();
      backend.listSessions = async () => {
        throw error;
      };
      const registry = new BackendRegistry(createLogger({ file, stdout: false, verbose: true }));
      registry.add(backend);
      expect(await registry.listSessions()).toEqual([]);
      const logged = readFileSync(file, "utf8");
      expect(logged).not.toContain(secret);
      expect(logged).toContain("listSessions failed");
      expect(logged).toContain('"backend":"iterm2"');
    });

    it(`does not persist ${label} while stopping screen capture`, () => {
      const backend = new FakeBackend();
      Object.assign(backend, {
        setWatched: () => {
          throw error;
        },
      });
      const tracker = new ScreenTracker({
        backend,
        sink: () => {},
        log: createLogger({ file, stdout: false, verbose: true }),
      });
      expect(() => tracker.stop()).not.toThrow();
      const logged = readFileSync(file, "utf8");
      expect(logged).not.toContain(secret);
      expect(logged).toContain("setWatched failed");
    });
  }
});
