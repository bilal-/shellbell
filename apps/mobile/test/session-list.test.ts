import { act, createElement, type ReactNode } from "react";
import { createRoot } from "test-renderer";
import { expect, it, vi } from "vitest";
import Computer from "../app/c/[fp]/index";
import { useConnectionsStore } from "../src/store/connections";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
vi.mock("expo-router", () => ({
  useLocalSearchParams: () => ({ fp: "computer" }),
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("react-native", () => ({ View: "View", Text: "Text", Pressable: "Pressable" }));
vi.mock("react-native-reanimated", () => ({
  default: { View: "AnimatedView" },
  Easing: { out: () => {}, ease: () => {} },
  LinearTransition: { duration: () => ({ easing: () => ({}) }) },
}));
vi.mock("@shopify/flash-list", () => ({
  FlashList: ({
    data,
    renderItem,
  }: {
    data: unknown[];
    renderItem: (input: { item: unknown; index: number }) => ReactNode;
  }) => createElement("FlashList", null, ...data.map((item, index) => renderItem({ item, index }))),
}));
vi.mock("../src/store/computers", () => ({
  useComputersStore: (selector: (state: unknown) => unknown) =>
    selector({ computers: [{ fp: "computer", name: "Fixture", accent: "emerald" }] }),
}));
vi.mock("../src/store/network", () => ({
  useNetworkStore: (selector: (state: unknown) => unknown) =>
    selector({ snapshot: { type: "WIFI", internet: "online", disconnected: false } }),
}));
vi.mock("../src/ui/NewSessionSheet", () => ({ NewSessionSheet: () => null }));
vi.mock("../src/ui/TransportStatus", () => ({ TransportStatus: () => null }));
vi.mock("../src/ui/EmptyState", () => ({ EmptyState: () => null }));
vi.mock("../src/ui/StatusOverlay", () => ({ StatusOverlay: () => null }));
vi.mock("../src/ui/Pill", () => ({ Pill: (props: object) => createElement("Pill", props) }));

it("uses the advertised adapter label in headers and pills, including catalog-only updates", async () => {
  useConnectionsStore.setState({ byComputer: {} });
  useConnectionsStore.getState().patch("computer", () => ({
    status: "online",
    sessions: [
      {
        id: "example:one",
        backend: "example",
        title: "Work",
        cols: 80,
        rows: 24,
        windowId: "example:window",
        windowNumber: 1,
        tabId: "example:tab",
        tabIndex: 0,
        paneIndex: 0,
        isFocusedOnMac: false,
        state: "unknown",
      },
    ],
    hello: {
      backendCatalog: [
        { name: "example", label: "Example Terminal", connected: true, launchable: false },
      ],
    } as never,
  }));
  const root = createRoot();
  await act(async () => root.render(createElement(Computer)));
  try {
    const header = () =>
      root.container
        .queryAll((node) => node.type === "Text")
        .map((node) => node.props.children)
        .filter((value) => typeof value === "string");
    const pills = () =>
      root.container.queryAll((node) => node.type === "Pill").map((node) => node.props.text);
    expect(header()).toContain("EXAMPLE TERMINAL · WINDOW 1");
    expect(pills()).toContain("Example Terminal");
    await act(async () =>
      useConnectionsStore.getState().patch("computer", (current) => ({
        hello: {
          ...current.hello,
          backendCatalog: current.hello?.backendCatalog?.map((entry) => ({
            ...entry,
            label: "Renamed Terminal",
          })),
        } as never,
      })),
    );
    expect(header()).toContain("RENAMED TERMINAL · WINDOW 1");
    expect(pills()).toContain("Renamed Terminal");
  } finally {
    await act(async () => root.unmount());
  }
});
