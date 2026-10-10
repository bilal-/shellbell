import { act, createElement } from "react";
import { createRoot } from "test-renderer";
import { beforeEach, expect, it, vi } from "vitest";
import { RelaySetting } from "../src/components/RelaySetting";

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
  await act(async () =>
    root.container.queryAll((node) => node.type === "Pressable")[0]!.props.onPress(),
  );
}
it("does not switch a relay until its operator notice is confirmed", async () => {
  const root = createRoot();
  try {
    await edit(root);
    expect(state.update).not.toHaveBeenCalled();
    expect(state.alert.mock.calls[0]![1]).toContain("wss://private.example.com");
    const buttons = state.alert.mock.calls[0]![2];
    await act(async () =>
      buttons.find((button: { text: string }) => button.text === "Use relay").onPress(),
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
    } finally {
      if (event !== "unmounted") await act(async () => root.unmount());
    }
  },
);
