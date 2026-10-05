import { beforeAll, expect, it, vi } from "vitest";
import type { PushIntent } from "../src/notifications/models.js";
import {
  createDirectNotificationProvider,
  parseDirectPushCredentials,
} from "../src/notifications/provider.js";

const now = 1_800_000_000_000;
const fcm: PushIntent = {
  destination: { provider: "fcm", token: "native-token" },
  route: { computerFp: "computer", sessionId: "session", kind: "idle" },
  genericTitle: "Shellbell",
  genericBody: "Ready",
  group: "group",
  expiresAtSeconds: now / 1000 + 120,
};
const apns: PushIntent = {
  ...fcm,
  destination: { provider: "apns", token: "abcdef", environment: "production" },
};
let rsa: string;
let ec: string;
beforeAll(async () => {
  const key = async (algorithm: RsaHashedKeyGenParams | EcKeyGenParams) => {
    const pair = await crypto.subtle.generateKey(algorithm, true, ["sign", "verify"]);
    const label = "PRIVATE KEY";
    return `-----BEGIN ${label}-----\n${Buffer.from(await crypto.subtle.exportKey("pkcs8", pair.privateKey)).toString("base64")}\n-----END ${label}-----`;
  };
  rsa = await key({
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
  });
  ec = await key({ name: "ECDSA", namedCurve: "P-256" });
});
it("rejects missing credentials without provider network I/O", async () => {
  const network = vi.fn<typeof fetch>();
  const provider = createDirectNotificationProvider({ fcmFetch: network, apnsFetch: network });
  expect(await provider.send([fcm, apns])).toEqual(
    Array(2).fill({ status: "rejected", code: "invalid-credentials" }),
  );
  expect(network).not.toHaveBeenCalled();
});
it("routes mixed intents to the correct authenticated transport and preserves result order", async () => {
  const fcmFetch = vi.fn<typeof fetch>(async (url) => {
    if (String(url) === "https://oauth2.googleapis.com/token")
      return Response.json({ access_token: "access", token_type: "Bearer", expires_in: 3600 });
    expect(String(url)).toBe("https://fcm.googleapis.com/v1/projects/test-project/messages:send");
    return Response.json({ name: "projects/test-project/messages/one" });
  });
  const apnsFetch = vi.fn<typeof fetch>(async (url, init) => {
    expect(String(url)).toBe("https://api.push.apple.com/3/device/abcdef");
    expect(new Headers(init?.headers).get("apns-topic")).toBe("dev.example.app");
    return Response.json({ reason: "DeviceTokenNotForTopic" }, { status: 400 });
  });
  const provider = createDirectNotificationProvider({
    fcm: { projectId: "test-project", clientEmail: "sender@example.test", privateKey: rsa },
    apns: { teamId: "TEAM123456", keyId: "KEY1234567", privateKey: ec, topic: "dev.example.app" },
    fcmFetch,
    apnsFetch,
    now: () => now,
  });
  expect(await provider.send([apns, fcm])).toEqual([
    { status: "rejected", code: "invalid-credentials" },
    { status: "accepted" },
  ]);
  expect(fcmFetch).toHaveBeenCalledTimes(2);
  expect(apnsFetch).toHaveBeenCalledTimes(1);
});
it("parses private service-account fields and independent APNs configuration", () => {
  expect(
    parseDirectPushCredentials({
      fcmServiceAccountJson: JSON.stringify({
        type: "service_account",
        project_id: "test-project",
        client_email: "sender@example.test",
        private_key: rsa,
      }),
      apnsPrivateKey: ec,
      apnsTeamId: "TEAM123456",
      apnsKeyId: "KEY1234567",
      apnsTopic: "dev.example.app",
    }),
  ).toEqual({
    fcm: { projectId: "test-project", clientEmail: "sender@example.test", privateKey: rsa },
    apns: { teamId: "TEAM123456", keyId: "KEY1234567", privateKey: ec, topic: "dev.example.app" },
  });
});
it("rejects unusable signing keys without sending private configuration to any provider", async () => {
  const network = vi.fn<typeof fetch>();
  const provider = createDirectNotificationProvider({
    fcm: {
      projectId: "test-project",
      clientEmail: "sender@example.test",
      privateKey: "malformed-private-key",
    },
    apns: {
      teamId: "TEAM123456",
      keyId: "KEY1234567",
      topic: "dev.example.app",
      privateKey: "malformed-private-key",
    },
    fcmFetch: network,
    apnsFetch: network,
    now: () => now,
  });
  expect(await provider.send([apns, fcm])).toEqual([
    { status: "rejected", code: "invalid-credentials" },
    { status: "rejected", code: "invalid-credentials" },
  ]);
  expect(network).not.toHaveBeenCalled();
});
it.each([
  "not-json-private-value",
  "null",
  "[]",
  JSON.stringify({ type: "authorized_user", private_key: "private-value" }),
])("disables malformed private config with sanitized diagnostics: %s", (fcmServiceAccountJson) => {
  const report = vi.fn();
  expect(
    parseDirectPushCredentials(
      {
        fcmServiceAccountJson,
        apnsPrivateKey: ec,
        apnsTeamId: "TEAM123456",
        apnsKeyId: "KEY1234567",
        apnsTopic: "wrong/topic",
      },
      report,
    ),
  ).toEqual({});
  expect(report.mock.calls).toEqual([
    ["fcm", "invalid-credentials"],
    ["apns", "invalid-credentials"],
  ]);
});
