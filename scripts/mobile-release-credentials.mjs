import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const appId = "sh.bilal.shellbell";
const group = `group.${appId}.notifications`;
function required(env, key) {
  assert.ok(typeof env[key] === "string" && env[key].trim(), `Missing ${key}`);
  return env[key];
}
function json(text, key) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Invalid ${key} JSON`);
  }
}
function binary(env, key) {
  const value = required(env, key);
  assert.ok(/^[A-Za-z0-9+/]+={0,2}$/.test(value), `Invalid ${key} encoding`);
  return Buffer.from(value, "base64");
}
export function credentialFiles(platform, env) {
  if (platform === "android") {
    const signing = json(required(env, "SHELLBELL_ANDROID_SIGNING_JSON"), "Android signing");
    for (const key of ["key_alias", "store_password", "key_password"]) required(signing, key);
    const play = json(required(env, "SHELLBELL_PLAY_CREDENTIALS_JSON"), "Play");
    assert.ok(
      play.type === "service_account" && play.private_key && play.client_email,
      "Invalid Play service account",
    );
    const firebase = json(required(env, "SHELLBELL_GOOGLE_SERVICES_JSON"), "Firebase");
    assert.ok(
      firebase.client?.some(
        (client) => client.client_info?.android_client_info?.package_name === appId,
      ),
      "Firebase configuration must match the app ID",
    );
    return {
      "android-signing.json": JSON.stringify(signing),
      "play.json": JSON.stringify(play),
      "google-services.json": JSON.stringify(firebase),
      "upload.p12": binary(env, "SHELLBELL_ANDROID_KEYSTORE_BASE64"),
    };
  }
  assert.equal(platform, "ios", "Unsupported release platform");
  const api = json(required(env, "SHELLBELL_ASC_API_KEY_JSON"), "App Store Connect");
  assert.ok(
    api.key_id && api.issuer_id && api.key && api.in_house === false,
    "Invalid App Store Connect key",
  );
  required(env, "SHELLBELL_IOS_CERTIFICATE_PASSWORD");
  required(env, "SHELLBELL_APPLE_TEAM_ID");
  required(env, "SHELLBELL_IOS_PROFILE");
  required(env, "SHELLBELL_IOS_NOTIFICATION_PROFILE");
  return {
    "api-key.json": JSON.stringify(api),
    "distribution.p12": binary(env, "SHELLBELL_IOS_CERTIFICATE_BASE64"),
    "host.mobileprovision": binary(env, "SHELLBELL_IOS_PROFILE_BASE64"),
    "notification.mobileprovision": binary(env, "SHELLBELL_IOS_NOTIFICATION_PROFILE_BASE64"),
  };
}

function mask(value) {
  if (typeof value === "string")
    console.log(
      `::add-mask::${value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A")}`,
    );
  else if (value && typeof value === "object")
    for (const entry of Object.values(value)) mask(entry);
}
function command(name, args, input) {
  const result = spawnSync(name, args, { input, encoding: "utf8" });
  assert.equal(result.status, 0, `Release credential ${name} operation failed`);
  return result.stdout.trim();
}
function stateFile(root) {
  return join(root, "cleanup.json");
}
function save(root, state) {
  writeFileSync(stateFile(root), JSON.stringify(state), { mode: 0o600 });
}

function installIos(root, env) {
  const keychain = join(root, "signing.keychain-db");
  const original = [
    ...command("security", ["list-keychains", "-d", "user"]).matchAll(/"([^"\n]+)"/g),
  ].map((match) => match[1]);
  const state = { keychain, original, profiles: [] };
  save(root, state);
  const password = randomBytes(32).toString("hex");
  mask(password);
  command("security", ["create-keychain", "-p", password, keychain]);
  command("security", ["set-keychain-settings", "-lut", "21600", keychain]);
  command("security", ["unlock-keychain", "-p", password, keychain]);
  command("security", [
    "import",
    join(root, "distribution.p12"),
    "-P",
    env.SHELLBELL_IOS_CERTIFICATE_PASSWORD,
    "-A",
    "-t",
    "cert",
    "-f",
    "pkcs12",
    "-k",
    keychain,
  ]);
  command("security", [
    "set-key-partition-list",
    "-S",
    "apple-tool:,apple:",
    "-s",
    "-k",
    password,
    keychain,
  ]);
  command("security", ["list-keychains", "-d", "user", "-s", keychain, ...original]);
  for (const [file, id, name] of [
    ["host.mobileprovision", appId, env.SHELLBELL_IOS_PROFILE],
    [
      "notification.mobileprovision",
      `${appId}.notifications`,
      env.SHELLBELL_IOS_NOTIFICATION_PROFILE,
    ],
  ]) {
    const plist = command("security", ["cms", "-D", "-i", join(root, file)]);
    const profile = JSON.parse(
      command(
        "python3",
        [
          "-c",
          'import plistlib,sys,json; p=plistlib.loads(sys.stdin.buffer.read()); d={k:p[k] for k in ["UUID","Name","TeamIdentifier","Entitlements"]}; d["ExpirationDate"]=p["ExpirationDate"].isoformat(); print(json.dumps(d))',
        ],
        plist,
      ),
    );
    assert.ok(
      profile.TeamIdentifier?.includes(env.SHELLBELL_APPLE_TEAM_ID),
      "Provisioning team mismatch",
    );
    assert.ok(
      profile.Name === name && /^[A-Fa-f0-9-]{36}$/.test(profile.UUID),
      "Provisioning profile mismatch",
    );
    assert.ok(
      Date.parse(`${profile.ExpirationDate}Z`) > Date.now(),
      "Provisioning profile expired",
    );
    assert.ok(
      profile.Entitlements?.["application-identifier"]?.endsWith(`.${id}`),
      "Provisioning app mismatch",
    );
    assert.ok(
      profile.Entitlements?.["com.apple.security.application-groups"]?.includes(group),
      "Notification group missing",
    );
    if (id === appId)
      assert.equal(
        profile.Entitlements["aps-environment"],
        "production",
        "TestFlight requires production APNs",
      );
    for (const directory of [
      "Library/MobileDevice/Provisioning Profiles",
      "Library/Developer/Xcode/UserData/Provisioning Profiles",
    ]) {
      const folder = join(required(env, "HOME"), directory);
      mkdirSync(folder, { recursive: true });
      const target = join(folder, `${profile.UUID}.mobileprovision`);
      assert.ok(!existsSync(target), "Refuse to replace an existing profile");
      state.profiles.push(target);
      save(root, state);
      writeFileSync(target, readFileSync(join(root, file)), { flag: "wx", mode: 0o600 });
    }
  }
}

function cleanup(root, env) {
  if (!existsSync(root)) return;
  if (existsSync(stateFile(root))) {
    const state = json(readFileSync(stateFile(root), "utf8"), "Cleanup state");
    assert.equal(state.keychain, join(root, "signing.keychain-db"));
    if (state.original.length)
      command("security", ["list-keychains", "-d", "user", "-s", ...state.original]);
    if (existsSync(state.keychain)) command("security", ["delete-keychain", state.keychain]);
    for (const profile of state.profiles) {
      const allowed = [
        "Library/MobileDevice/Provisioning Profiles",
        "Library/Developer/Xcode/UserData/Provisioning Profiles",
      ].some(
        (path) =>
          profile.startsWith(`${join(required(env, "HOME"), path)}/`) &&
          /^[A-Fa-f0-9-]{36}\.mobileprovision$/.test(profile.split("/").at(-1)),
      );
      assert.ok(allowed, "Invalid cleanup profile path");
      rmSync(profile, { force: true });
    }
  }
  rmSync(root, { recursive: true });
}

function main() {
  const [operation, platform] = process.argv.slice(2);
  const env = process.env;
  assert.equal(env.GITHUB_ACTIONS, "true", "Credential materialization is restricted to hosted CI");
  assert.equal(
    env.RUNNER_ENVIRONMENT,
    "github-hosted",
    "Do not install release credentials on a persistent runner",
  );
  const root = join(required(env, "RUNNER_TEMP"), "shellbell-mobile-release");
  if (operation === "cleanup") {
    cleanup(root, env);
    return;
  }
  assert.equal(operation, "prepare");
  const files = credentialFiles(platform, env);
  for (const [key, value] of Object.entries(env))
    if (key.startsWith("SHELLBELL_") && /JSON|PASSWORD|BASE64/.test(key)) {
      mask(value);
      if (key.endsWith("_JSON")) mask(json(value, key));
    }
  mkdirSync(root, { mode: 0o700 });
  for (const [name, bytes] of Object.entries(files))
    writeFileSync(join(root, name), bytes, { mode: 0o600, flag: "wx" });
  if (platform === "ios") installIos(root, env);
  const paths =
    platform === "android"
      ? {
          SHELLBELL_ANDROID_SIGNING_CONFIG: "android-signing.json",
          SHELLBELL_PLAY_CREDENTIALS_PATH: "play.json",
          SHELLBELL_GOOGLE_SERVICES_FILE: "google-services.json",
          SHELLBELL_ANDROID_KEYSTORE: "upload.p12",
        }
      : { SHELLBELL_ASC_API_KEY_PATH: "api-key.json" };
  for (const [key, file] of Object.entries(paths))
    appendFileSync(required(env, "GITHUB_ENV"), `${key}=${join(root, file)}\n`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
