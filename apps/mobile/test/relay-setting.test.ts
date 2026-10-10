import { act, createElement } from "react";
import { createRoot } from "test-renderer";
import { beforeEach, expect, it, vi } from "vitest";
import { RelaySetting } from "../src/components/RelaySetting";
import { acceptRelay, hasAcceptedRelay } from "../src/store/consent";
import { consentStorage, resetConsentStorage } from "./helpers/consent-storage";

vi.mock("expo-sqlite/kv-store", async () => ({
  default: (await import("./helpers/consent-storage")).consentStorage,
}));

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
const state = vi.hoisted(() => ({
  computers: [{ fp: "computer", relayUrl: "wss://relay.shellbell.dev", removing: false }],
  update: vi.fn(),
  alert: vi.fn(),
}));
vi.mock("react-native", () => ({
  View: "View",
  Text: "Text",
  TextInput: "TextInput",
  Pressable: "Pressable",
  Switch: "Switch",
  Alert: { alert: state.alert },
}));
vi.mock("../src/store/computers", () => ({ useComputersStore: { getState: () => state } }));
beforeEach(() => {
  resetConsentStorage();
  vi.clearAllMocks();
  state.computers = [{ fp: "computer", relayUrl: "wss://relay.shellbell.dev", removing: false }];
});
async function edit(root: ReturnType<typeof createRoot>) {
  await act(async () =>
    root.render(
      createElement(RelaySetting, { fp: "computer", relayUrl: "wss://relay.shellbell.dev" }),
    ),
  );
  await act(async () =>
    root.container
      .queryAll((node) => node.type === "TextInput")[0]!
      .props.onChangeText("wss://private.example.com"),
  );
  await act(async () => {
    void root.container.queryAll((node) => node.type === "Pressable")[0]!.props.onPress();
  });
}
it("does not switch a relay until its operator notice is confirmed", async () => {
  const root = createRoot();
  try {
    await edit(root);
    expect(state.update).not.toHaveBeenCalled();
    expect(state.alert.mock.calls[0]![1]).toContain("wss://private.example.com");
    const buttons = state.alert.mock.calls[0]![2];
    await act(async () =>
      buttons.find((button: { text: string }) => button.text === "Agree").onPress(),
    );
    expect(state.update).toHaveBeenCalledWith("computer", {
      relayUrl: "wss://private.example.com",
    });
  } finally {
    await act(async () => root.unmount());
  }
});
it.each(["cancel", "dismiss", "removed", "changed", "unmounted"])(
  "keeps settings after a %s confirmation",
  async (event) => {
    const root = createRoot();
    try {
      await edit(root);
      const [, , buttons, options] = state.alert.mock.calls[0]!;
      if (event === "cancel") await act(async () => buttons[0].onPress());
      if (event === "dismiss") await act(async () => options.onDismiss());
      if (event === "removed") state.computers[0]!.removing = true;
      if (event === "changed") state.computers[0]!.relayUrl = "wss://other.example.com";
      if (event === "unmounted") await act(async () => root.unmount());
      if (["removed", "changed", "unmounted"].includes(event))
        await act(async () => buttons[1].onPress());
      expect(state.update).not.toHaveBeenCalled();
      expect(hasAcceptedRelay("wss://private.example.com")).toBe(false);
    } finally {
      if (event !== "unmounted") await act(async () => root.unmount());
    }
  },
);

it("does not repeat a previously accepted origin's notice", async () => {
  acceptRelay("wss://PRIVATE.example.com:443/");
  const root = createRoot();
  try {
    await edit(root);
    expect(state.alert).not.toHaveBeenCalled();
    expect(state.update).toHaveBeenCalledWith("computer", {
      relayUrl: "wss://private.example.com",
    });
  } finally {
    await act(async () => root.unmount());
  }
});

it("keeps the saved relay when agreement storage fails", async () => {
  const root = createRoot();
  try {
    await edit(root);
    consentStorage.setItemSync.mockImplementation(() => {
      throw new Error("locked");
    });
    await act(async () => state.alert.mock.calls[0]![2][1].onPress());
    expect(state.update).not.toHaveBeenCalled();
    expect(hasAcceptedRelay("wss://private.example.com")).toBe(false);
    expect(
      root.container.queryAll((node) => node.props.accessibilityRole === "alert")[0]!.props
        .children,
    ).toBe("Could not save your relay choice. Please try again.");
  } finally {
    await act(async () => root.unmount());
  }
});
