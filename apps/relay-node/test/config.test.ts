import { execFileSync, spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { parseCommand } from "../src/command.js";
import { loadNodePushCredentials, resolveConfig } from "../src/config.js";
import { temporaryDirectory } from "./helpers.js";

it("rejects whitespace-heavy malformed PEM promptly without blocking configuration", () => {
  // A subprocess deadline safely catches a synchronous parser stall, which a
  // Vitest timeout cannot interrupt. Node relay already owns the tsx dependency.
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      `
    import { parseDirectPushCredentials } from "@shellbell/relay-core";
    const label = "PRIVATE KEY";
    const marker = "-----BEGIN " + label + "-----";
    const diagnostics = [];
    for (const privateKey of [marker + " ".repeat(16000), marker + " ".repeat(16000) + "-----END " + label + "-----"]) {
      const result = parseDirectPushCredentials({
        fcmServiceAccountJson: JSON.stringify({ type: "service_account", project_id: "test-project", client_email: "sender@example.test", private_key: privateKey }),
        apnsPrivateKey: privateKey, apnsTeamId: "TEAM123456", apnsKeyId: "KEY1234567", apnsTopic: "dev.example.app",
      }, (...args) => diagnostics.push(args));
      if (Object.keys(result).length) throw new Error("Malformed credentials accepted");
    }
    console.log(JSON.stringify(diagnostics));
  `,
    ],
    { timeout: 5000, encoding: "utf8" },
  );
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual([
    ["fcm", "invalid-credentials"],
    ["apns", "invalid-credentials"],
    ["fcm", "invalid-credentials"],
    ["apns", "invalid-credentials"],
  ]);
}, 10000);

it.each(["", "1.5", "-1", "NaN", "1e3", " 2", "9007199254740992"])(
  "refuses invalid CLI integer %j",
  (port) => {
    expect(() =>
      parseCommand(["serve", "--data-dir", "/private/data", "--port", port], {}),
    ).toThrow();
  },
);
it.each(["fcm", "apns"])(
  "rejects malformed PEM on actual %s sends without blocking or network I/O",
  (provider) => {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        `
    import { createDirectNotificationProvider, parseDirectPushCredentials } from "@shellbell/relay-core";
    const label = "PRIVATE KEY";
    const begin = "-----BEGIN " + label + "-----";
    const end = "-----END " + label + "-----";
    const provider = ${JSON.stringify(provider)};
    const now = 1800000000000;
    const intent = { destination: { provider, token: "abcdef", ...(provider === "apns" ? { environment: "production" } : {}) }, route: { computerFp: "computer", sessionId: "session", kind: "idle" }, genericTitle: "Shellbell", genericBody: "Ready", group: "group", expiresAtSeconds: now / 1000 + 120 };
    let networkCalls = 0;
    const transport = async () => { networkCalls++; throw new Error("Unexpected network I/O"); };
    const outcomes = [];
    for (const privateKey of [begin + " ".repeat(15900) + "AAAA" + end, begin + " ".repeat(15900), begin + " ".repeat(15900) + end]) {
      const embedded = { fcm: { projectId: "test-project", clientEmail: "sender@example.test", privateKey }, apns: { teamId: "TEAM123456", keyId: "KEY1234567", topic: "dev.example.app", privateKey } };
      const parsed = parseDirectPushCredentials({ fcmServiceAccountJson: JSON.stringify({ type: "service_account", project_id: "test-project", client_email: "sender@example.test", private_key: privateKey }), apnsPrivateKey: privateKey, apnsTeamId: "TEAM123456", apnsKeyId: "KEY1234567", apnsTopic: "dev.example.app" });
      for (const credentials of [parsed, embedded]) {
        outcomes.push(...await createDirectNotificationProvider({ ...credentials, fcmFetch: transport, apnsFetch: transport, now: () => now }).send([intent]));
      }
    }
    console.log(JSON.stringify({ outcomes, networkCalls }));
  `,
      ],
      { timeout: 5000, encoding: "utf8" },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      outcomes: Array(6).fill({ status: "rejected", code: "invalid-credentials" }),
      networkCalls: 0,
    });
  },
  10000,
);
it("requires explicit persistent storage and preserves explicit bind settings", () => {
  expect(() => parseCommand(["serve"], {})).toThrow(/data/);
  expect(
    parseCommand(
      ["serve", "--data-dir", "/private/data", "--host", "0.0.0.0", "--port", "9000"],
      {},
    ),
  ).toMatchObject({
    command: "serve",
    config: { dataDir: "/private/data", host: "0.0.0.0", port: 9000 },
  });
  expect(() => resolveConfig({ dataDir: ":memory:" })).toThrow();
});
it("does not disclose invalid CLI values or credentials through validation errors", () => {
  try {
    parseCommand(["serve", "--port", "synthetic-secret"], {
      SHELLBELL_FCM_SERVICE_ACCOUNT_FILE: "synthetic-secret",
    });
  } catch (error) {
    expect(String(error)).not.toContain("synthetic-secret");
    return;
  }
  throw new Error("Expected invalid command rejection");
});
it("takes credential file paths and APNs app identity only from private environment", () => {
  expect(
    parseCommand(["serve", "--data-dir", "/private/data"], {
      SHELLBELL_FCM_SERVICE_ACCOUNT_FILE: "/private/fcm.json",
      SHELLBELL_APNS_PRIVATE_KEY_FILE: "/private/apns.p8",
      SHELLBELL_APNS_TEAM_ID: "TEAM123456",
      SHELLBELL_APNS_KEY_ID: "KEY1234567",
      SHELLBELL_APNS_TOPIC: "dev.example.app",
    }),
  ).toMatchObject({
    config: {
      fcmServiceAccountFile: "/private/fcm.json",
      apnsPrivateKeyFile: "/private/apns.p8",
      apnsTeamId: "TEAM123456",
      apnsKeyId: "KEY1234567",
      apnsTopic: "dev.example.app",
    },
  });
});
it.each([false, true])("reads regular private credential files (symlink: %s)", async (symlink) => {
  const dir = temporaryDirectory();
  const privateKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();
  const path = join(dir, "apns.p8");
  writeFileSync(path, privateKey, { mode: 0o600 });
  const configuredPath = symlink ? join(dir, "mounted-secret.p8") : path;
  if (symlink) symlinkSync(path, configuredPath);
  try {
    const credentials = await loadNodePushCredentials({
      dataDir: dir,
      apnsPrivateKeyFile: configuredPath,
      apnsTeamId: "TEAM123456",
      apnsKeyId: "KEY1234567",
      apnsTopic: "dev.example.app",
    });
    expect(credentials.apns).toEqual({
      privateKey,
      teamId: "TEAM123456",
      keyId: "KEY1234567",
      topic: "dev.example.app",
    });
  } finally {
    rmSync(dir, { recursive: true });
  }
});
it.each([false, true])(
  "rejects a credential FIFO without a writer before startup (symlink: %s)",
  (symlink) => {
    const dir = temporaryDirectory();
    const fifo = join(dir, "private-credential-fifo");
    execFileSync("mkfifo", [fifo]);
    const path = symlink ? join(dir, "mounted-secret") : fifo;
    if (symlink) symlinkSync(fifo, path);
    try {
      // Terminating the child also releases the old implementation's blocked open.
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "--input-type=module",
          "--eval",
          `
      import { loadNodePushCredentials } from ${JSON.stringify(new URL("../src/config.ts", import.meta.url).href)};
      const diagnostics = [];
      const credentials = await loadNodePushCredentials({ dataDir: ${JSON.stringify(dir)}, fcmServiceAccountFile: ${JSON.stringify(path)}, apnsPrivateKeyFile: ${JSON.stringify(path)} }, (...args) => diagnostics.push(args));
      console.log(JSON.stringify({ credentials, diagnostics }));
    `,
        ],
        { timeout: 5000, encoding: "utf8" },
      );
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        credentials: {},
        diagnostics: [
          ["fcm", "invalid-credentials"],
          ["apns", "invalid-credentials"],
        ],
      });
    } finally {
      rmSync(dir, { recursive: true });
    }
  },
  10000,
);
it("bounds private files and sanitizes unreadable or malformed credential diagnostics", async () => {
  const dir = temporaryDirectory();
  const path = join(dir, "private-fcm.json");
  writeFileSync(path, "sensitive-value".repeat(10000));
  const report = vi.fn();
  try {
    expect(
      await loadNodePushCredentials(
        {
          dataDir: dir,
          fcmServiceAccountFile: path,
          apnsPrivateKeyFile: join(dir, "nonexistent-secret.p8"),
        },
        report,
      ),
    ).toEqual({});
    expect(report.mock.calls).toEqual([
      ["fcm", "invalid-credentials"],
      ["apns", "invalid-credentials"],
    ]);
  } finally {
    rmSync(dir, { recursive: true });
  }
});
