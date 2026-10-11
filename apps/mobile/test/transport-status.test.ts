import { act, createElement } from "react";
import { createRoot } from "test-renderer";
import { expect, it, vi } from "vitest";
import { useConnectionsStore } from "../src/store/connections";
import { TransportStatus } from "../src/ui/TransportStatus";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
vi.mock("react-native", () => ({
  ActivityIndicator: "ActivityIndicator",
  Pressable: "Pressable",
  Text: "Text",
  View: "View",
}));
vi.mock("../src/net/manager", () => ({ connectionManager: { get: () => undefined } }));
vi.mock("../src/store/network", () => ({
  useNetworkStore: (selector: (state: unknown) => unknown) =>
    selector({ snapshot: { type: "WIFI", internet: "online", disconnected: false } }),
}));
vi.mock("../src/ui/AppIcon", () => ({
  AppIcon: (props: object) => createElement("AppIcon", props),
}));

it("expands direct connection details with a chevron, not a plus", async () => {
  useConnectionsStore.setState({ byComputer: {} });
  useConnectionsStore.getState().patch("computer", () => ({
    status: "online",
    transport: {
      route: "direct",
      ready: true,
      phase: "none",
      retryPending: false,
      lastFailure: null,
    } as never,
  }));
  const root = createRoot();
  await act(async () => root.render(createElement(TransportStatus, { fp: "computer" })));
  try {
    const icon = () => root.container.queryAll((node) => node.type === "AppIcon")[0]!;
    const toggle = root.container.queryAll(
      (node) => node.type === "Pressable" && node.props.accessibilityRole === "button",
    )[0]!;
    expect(icon().props.name).toBe("chevronDown");
    await act(async () => toggle.props.onPress());
    expect(icon().props.name).toBe("chevronUp");
  } finally {
    await act(async () => root.unmount());
  }
});
