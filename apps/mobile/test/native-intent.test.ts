/// <reference types="vite/client" />

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { parseDeepLink } from "../src/notifications/routing";
import { sidToRoute } from "../src/util/routes";

type Intent = {
  redirectSystemPath: (event: { path: string; initial: boolean }) => string | null;
};
const modules = import.meta.glob<Intent>("../app/+native-intent.{ts,tsx}", { eager: true });
const intent = Object.values(modules)[0];
const require = createRequire(import.meta.url);
const paired = "a".repeat(26);
const unpaired = "b".repeat(26);

// Exercise the installed router's cold-start and URL subscription code unchanged.
// Native URL delivery and unrelated navigation serialization are isolated here.
function routerLinking(url: string, os: "ios" | "android") {
  const listeners = new Set<(event: { url: string }) => void | Promise<void>>();
  const native = {
    getLinkingURL: () => url,
    addEventListener: (_event: string, listener: (event: { url: string }) => void) => {
      listeners.add(listener);
      return { remove: () => listeners.delete(listener) };
    },
  };
  function load(id: string, dependencies: Record<string, unknown>) {
    const filename = require.resolve(`expo-router/build/${id}`);
    const exports: Record<string, unknown> = {};
    runInNewContext(readFileSync(filename, "utf8"), {
      exports,
      window: {},
      require: (name: string) => {
        if (!(name in dependencies)) throw new Error(`Unexpected router dependency: ${name}`);
        return dependencies[name];
      },
    });
    return exports;
  }
  const redirects = { applyRedirects: (path: string) => path };
  const linking = load("link/linking.js", {
    "expo-linking": native,
    "react-native": { Platform: { OS: os } },
    "../fork/extractPathFromURL": {},
    "../fork/getPathFromState": {},
    "../fork/getStateFromPath": {},
    "../fork/useLinking": { getInitialURLWithTimeout: async () => url },
    "../getRoutesRedirects": redirects,
  });
  const { getLinkingConfig } = load("getLinkingConfig.js", {
    "expo-modules-core": { Platform: { OS: os } },
    "./constants": require("expo-router/build/constants"),
    "./getReactNavigationConfig": require("expo-router/build/getReactNavigationConfig"),
    "./getRoutesRedirects": redirects,
    "./link/linking": linking,
    "./react-navigation/native": {},
  }) as {
    getLinkingConfig: (...args: unknown[]) => {
      getInitialURL: () => string | null | Promise<string | null>;
      subscribe: (listener: (url: string) => void) => () => void;
    };
  };
  const context = Object.assign(() => intent, {
    keys: () => (intent ? ["./+native-intent.tsx"] : []),
  });
  const config = getLinkingConfig(
    { route: "", children: [{ route: "index", children: [] }] },
    context,
    () => ({ segments: [] }),
    { skipGenerated: true },
  );
  return {
    config,
    native,
    deliver: () => Promise.all([...listeners].map((listener) => listener({ url }))),
  };
}

describe.each(["ios", "android"] as const)("%s system deep links", (os) => {
  it.each([
    `shellbell://c/${unpaired}`,
    `shellbell://c/${unpaired}/s/${sidToRoute("ended-session")}`,
    `shellbell://c/${paired}/s/${sidToRoute("current-session")}`,
  ])("leaves cold and warm computer links to the checked handler: %s", async (url) => {
    const { config, native, deliver } = routerLinking(url, os);
    expect(await config.getInitialURL()).toBeNull();
    const autoNavigate = vi.fn();
    const checkedTargets = vi.fn();
    config.subscribe(autoNavigate);
    native.addEventListener("url", ({ url }) => checkedTargets(parseDeepLink(url, [paired])));
    await deliver();
    expect(autoNavigate).not.toHaveBeenCalled();
    expect(checkedTargets).toHaveBeenCalledExactlyOnceWith(
      url.includes(unpaired)
        ? null
        : { computerFp: paired, sessionRoute: sidToRoute("current-session") },
    );
  });

  it("does not let a warm unpaired notification bypass the checked handler", async () => {
    const url = `shellbell://c/${unpaired}/s/${sidToRoute("ended-session")}`;
    expect(parseDeepLink(url, [paired])).toBeNull();
    const { config, deliver } = routerLinking(url, os);
    const autoNavigate = vi.fn();
    config.subscribe(autoNavigate);
    await deliver();
    expect(autoNavigate).not.toHaveBeenCalled();
  });

  it.each(["shellbell://pair", "shellbell://settings", "shellbell://dev/render-spike"])(
    "preserves automatic routing for %s",
    async (url) => {
      const { config, deliver } = routerLinking(url, os);
      expect(await config.getInitialURL()).toBe(url);
      const navigate = vi.fn();
      config.subscribe(navigate);
      await deliver();
      expect(navigate).toHaveBeenCalledExactlyOnceWith(url);
    },
  );
});

it.each([
  "/c/malformed",
  "c/malformed/s/invalid",
  "shellbell:///c/malformed",
  "shellbell://%63/malformed",
  "shellbell:///settings/../c/malformed",
  "https://shellbell.dev/c/malformed",
  "shellbell://c/%invalid",
])("does not auto-route alternate or malformed computer paths: %s", async (url) => {
  const { config, deliver } = routerLinking(url, "ios");
  expect(await config.getInitialURL()).toBeNull();
  const navigate = vi.fn();
  config.subscribe(navigate);
  await deliver();
  expect(navigate).not.toHaveBeenCalled();
});
