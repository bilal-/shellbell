import { act, createElement, useEffect } from "react";
import { createRoot } from "test-renderer";
import { beforeEach, expect, it, vi } from "vitest";
import { TermsGate } from "../src/components/TermsGate";
import { acceptTerms, hasAcceptedTerms, PRIVACY_URL, TERMS_URL } from "../src/store/consent";
import { consentData, consentStorage, resetConsentStorage } from "./helpers/consent-storage";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
const openURL = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("expo-sqlite/kv-store", async () => ({
  default: (await import("./helpers/consent-storage")).consentStorage,
}));
vi.mock("react-native", () => ({
  View: "View",
  Text: "Text",
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  Linking: { openURL },
  StyleSheet: { create: (value: unknown) => value },
}));
vi.mock("react-native-safe-area-context", () => ({ SafeAreaView: "SafeAreaView" }));
beforeEach(() => {
  resetConsentStorage();
  vi.clearAllMocks();
});

const start = vi.fn();
function App() {
  useEffect(() => {
    start();
  }, []);
  return createElement("ConnectedApp");
}
function button(root: ReturnType<typeof createRoot>, label: string) {
  return root.container
    .queryAll((node) => node.type === "Pressable")
    .find((node) => node.props.children.props.children === label)!;
}
async function mount() {
  const root = createRoot();
  await act(async () => root.render(createElement(TermsGate, null, createElement(App))));
  return root;
}
it("does not mount the app before agreement, including after decline and review", async () => {
  const root = await mount();
  try {
    expect(start).not.toHaveBeenCalled();
    await act(async () => button(root, "Decline").props.onPress());
    expect(hasAcceptedTerms()).toBe(false);
    expect(start).not.toHaveBeenCalled();
    await act(async () => button(root, "Review terms").props.onPress());
    expect(start).not.toHaveBeenCalled();
    await act(async () => button(root, "Agree").props.onPress());
    expect(hasAcceptedTerms()).toBe(true);
    expect(start).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
  }
});
it("opens the versioned terms and unchanged privacy URL without starting the app", async () => {
  const root = await mount();
  try {
    await act(async () => button(root, "Terms of Use").props.onPress());
    await act(async () => button(root, "Privacy").props.onPress());
    expect(openURL.mock.calls).toEqual([[TERMS_URL], [PRIVACY_URL]]);
    expect(start).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
  }
});
it("skips the prompt on a later launch with the same accepted terms", async () => {
  acceptTerms();
  const root = await mount();
  try {
    expect(start).toHaveBeenCalledTimes(1);
    expect(button(root, "Agree")).toBeUndefined();
  } finally {
    await act(async () => root.unmount());
  }
});
it("asks again for an older agreement", async () => {
  consentData.set(
    "shellbell.terms.v1",
    JSON.stringify({ version: "older", acceptedAt: "2025-01-01" }),
  );
  const root = await mount();
  try {
    expect(start).not.toHaveBeenCalled();
    expect(button(root, "Agree")).toBeDefined();
  } finally {
    await act(async () => root.unmount());
  }
});
it.each(["read", "write"])(
  "keeps the app blocked when the agreement cannot be %s",
  async (failure) => {
    if (failure === "read")
      consentStorage.getItemSync.mockImplementation(() => {
        throw new Error("locked");
      });
    const root = await mount();
    try {
      if (failure === "write") {
        consentStorage.setItemSync.mockImplementation(() => {
          throw new Error("locked");
        });
        await act(async () => button(root, "Agree").props.onPress());
      }
      expect(start).not.toHaveBeenCalled();
      expect(
        root.container.queryAll((node) => node.props.accessibilityRole === "alert"),
      ).toHaveLength(1);
    } finally {
      await act(async () => root.unmount());
    }
  },
);
