import assert from "node:assert/strict";
import { test } from "node:test";
import { credentialFiles } from "./mobile-release-credentials.mjs";

const android = {
  SHELLBELL_ANDROID_SIGNING_JSON: JSON.stringify({
    key_alias: "fixture",
    store_password: "password",
    key_password: "password",
  }),
  SHELLBELL_ANDROID_KEYSTORE_BASE64: Buffer.from("fixture").toString("base64"),
  SHELLBELL_PLAY_CREDENTIALS_JSON: JSON.stringify({
    type: "service_account",
    private_key: "fixture",
    client_email: "upload@example.com",
  }),
  SHELLBELL_GOOGLE_SERVICES_JSON: JSON.stringify({
    client: [{ client_info: { android_client_info: { package_name: "sh.bilal.shellbell" } } }],
  }),
};
test("requires all Android signing and matching Firebase inputs before materialization", () => {
  const files = credentialFiles("android", android);
  assert.equal(files["upload.p12"].toString(), "fixture");
  for (const key of Object.keys(android))
    assert.throws(() => credentialFiles("android", { ...android, [key]: "" }), /Missing/);
  assert.throws(
    () =>
      credentialFiles("android", { ...android, SHELLBELL_GOOGLE_SERVICES_JSON: '{"client":[]}' }),
    /app ID/,
  );
});
test("malformed JSON errors never echo secret text", () => {
  assert.throws(
    () =>
      credentialFiles("android", {
        ...android,
        SHELLBELL_PLAY_CREDENTIALS_JSON: "PRIVATE_SECRET invalid",
      }),
    (error) => !error.message.includes("PRIVATE_SECRET") && error.message.includes("Invalid Play"),
  );
});
test("requires host and notification profiles and a standard Apple team key", () => {
  const ios = {
    SHELLBELL_ASC_API_KEY_JSON: JSON.stringify({
      key_id: "fixture",
      issuer_id: "fixture",
      key: "private",
      in_house: false,
    }),
    SHELLBELL_IOS_CERTIFICATE_BASE64: "Zml4dHVyZQ==",
    SHELLBELL_IOS_CERTIFICATE_PASSWORD: "fixture",
    SHELLBELL_APPLE_TEAM_ID: "ABCDEFGHIJ",
    SHELLBELL_IOS_PROFILE: "host",
    SHELLBELL_IOS_NOTIFICATION_PROFILE: "extension",
    SHELLBELL_IOS_PROFILE_BASE64: "Zml4dHVyZQ==",
    SHELLBELL_IOS_NOTIFICATION_PROFILE_BASE64: "Zml4dHVyZQ==",
  };
  assert.deepEqual(Object.keys(credentialFiles("ios", ios)), [
    "api-key.json",
    "distribution.p12",
    "host.mobileprovision",
    "notification.mobileprovision",
  ]);
  for (const key of Object.keys(ios))
    assert.throws(() => credentialFiles("ios", { ...ios, [key]: "" }), /Missing/);
});
