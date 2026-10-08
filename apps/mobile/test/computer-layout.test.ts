import { act, createElement } from "react";
import { createRoot } from "test-renderer";
import { expect, it, vi } from "vitest";
import ComputerLayout from "../app/c/[fp]/_layout";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
const dismissTo = vi.hoisted(() => vi.fn());
vi.mock("expo-router", () => ({
  Stack: (props: { children: import("react").ReactNode }) =>
    createElement("Stack", props, props.children),
  useLocalSearchParams: () => ({ fp: "computer" }),
  useRouter: () => ({ dismissTo }),
}));
vi.mock("react-native", () => ({ Pressable: "Pressable" }));
vi.mock("../src/store/computers", () => ({
  useComputersStore: (select: (state: unknown) => unknown) =>
    select({ computers: [{ fp: "computer", name: "Test computer" }] }),
}));

it("provides a visible route back to Computers from the nested session list", async () => {
  const { Stack } = await import("expo-router");
  Object.assign(Stack, {
    Screen: (props: { name: string; options?: { headerLeft?: () => import("react").ReactNode } }) =>
      createElement("StackScreen", props, props.options?.headerLeft?.()),
  });
  const root = createRoot();
  try {
    await act(async () => root.render(createElement(ComputerLayout)));
    const back = root.container.queryAll(
      (node) => node.type === "Pressable" && node.props.accessibilityLabel === "Back to computers",
    )[0];
    expect(back).toBeDefined();
    await act(async () => back!.props.onPress());
    expect(dismissTo).toHaveBeenCalledExactlyOnceWith("/");
  } finally {
    await act(async () => root.unmount());
  }
});
