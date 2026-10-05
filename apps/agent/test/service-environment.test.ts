import { describe, expect, it } from "vitest";
import { serviceEnvironment } from "../src/service-environment.js";

const base = {
  stateDir: "/Users/test/State & Work",
  serviceInstance: "123e4567-e89b-42d3-a456-426614174000",
  nodePath: "/opt/custom/node/bin/node",
};

describe("serviceEnvironment", () => {
  it.each(["\u0000", "\u0001", "\ud800", "\ufffe"])(
    "rejects invalid persisted text without echoing its contents (%j)",
    (invalid) => {
      for (const key of ["HERDR_SOCKET_PATH", "XDG_CONFIG_HOME", "PATH"]) {
        expect(() =>
          serviceEnvironment({ ...base, env: { [key]: `/PRIVATE_SENTINEL${invalid}` } }),
        ).toThrow(/invalid.*text|invalid.*character/i);
        try {
          serviceEnvironment({ ...base, env: { [key]: `/PRIVATE_SENTINEL${invalid}` } });
        } catch (error) {
          expect(String(error)).not.toContain("PRIVATE_SENTINEL");
        }
      }
    },
  );
  it("persists only explicit state, instance, backend paths, and sanitized PATH", () => {
    expect(
      serviceEnvironment({
        ...base,
        env: {
          PATH: ":relative:/usr/bin:/opt/custom/node/bin:/usr/bin:/tmp/tools:",
          HERDR_SOCKET_PATH: "/tmp/herdr.sock",
          XDG_CONFIG_HOME: "/Users/test/.config",
          HERDR_SESSION: "private-session",
          SHELLBELL_SECRET_SENTINEL: "private-secret",
        },
      }),
    ).toEqual({
      SHELLBELL_DIR: "/Users/test/State & Work",
      SHELLBELL_SERVICE_INSTANCE: "123e4567-e89b-42d3-a456-426614174000",
      PATH: "/opt/custom/node/bin:/usr/bin:/tmp/tools:/opt/homebrew/bin:/usr/local/bin:/bin",
      HERDR_SOCKET_PATH: "/tmp/herdr.sock",
      XDG_CONFIG_HOME: "/Users/test/.config",
    });
  });

  it("rejects invalid state, instance and optional backend paths", () => {
    expect(() => serviceEnvironment({ ...base, stateDir: "relative", env: {} })).toThrow();
    expect(() => serviceEnvironment({ ...base, serviceInstance: "not-uuid", env: {} })).toThrow();
    expect(() => serviceEnvironment({ ...base, env: { HERDR_SOCKET_PATH: "relative" } })).toThrow();
    expect(() => serviceEnvironment({ ...base, env: { XDG_CONFIG_HOME: "relative" } })).toThrow();
  });
});
