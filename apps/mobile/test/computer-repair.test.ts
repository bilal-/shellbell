import { act, createElement } from "react";
import { createRoot } from "test-renderer";
import { expect, it, vi } from "vitest";

const platform = vi.hoisted(() => ({
  alert: vi.fn(),
  push: vi.fn(),
  replace: vi.fn(),
  deletePairSecret: vi.fn(async () => {}),
}));
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
vi.mock("react-native", () => ({
  Alert: { alert: platform.alert },
  AppState: { currentState: "active", addEventListener: () => ({ remove() {} }) },
  Pressable: "Pressable",
  Text: "Text",
  View: "View",
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ left: 0, right: 0 }),
}));
vi.mock("expo-router", () => ({
  useLocalSearchParams: () => ({ fp: "computer" }),
  useRouter: () => ({ push: platform.push, replace: platform.replace }),
}));
vi.mock("expo-sqlite/kv-store", () => ({
  default: { getItemSync: () => null, setItemSync() {} },
}));
vi.mock("@shopify/flash-list", () => ({ FlashList: () => null }));
vi.mock("../src/net/manager", () => ({ connectionManager: { get: () => undefined } }));
vi.mock("../src/identity/keys", () => ({
  loadPairSecret: async () => null,
  loadExistingIdentity: async () => {
    throw new Error("not needed for a legacy pair");
  },
  deletePairSecret: platform.deletePairSecret,
  migrateStoredKeys: async () => {},
}));
vi.mock("../src/net/revocation-retry", () => ({
  durableRevocationOutbox: () => ({ put() {} }),
  retryPendingRevocations: async () => {},
}));
vi.mock("../src/notifications", () => ({
  dismissComputerNotifications: async () => {},
  kvTitleStorage: { getItemSync: () => null, setItemSync() {} },
}));
vi.mock("../src/notifications/native", () => ({
  nativeNotificationsAvailable: false,
  nativeNotifications: {},
}));
vi.mock("../src/ui/NewSessionSheet", () => ({ NewSessionSheet: () => null }));
vi.mock("../src/ui/TransportStatus", () => ({ TransportStatus: () => null }));
vi.mock("../src/ui/EmptyState", () => ({
  EmptyState: (props: object) => createElement("EmptyState", props),
}));
vi.mock("../src/ui/StatusOverlay", () => ({ StatusOverlay: () => null }));
vi.mock("../src/ui/Pill", () => ({ Pill: () => null }));

import Computer from "../app/c/[fp]/index";
import { useComputersStore } from "../src/store/computers";
import { useConnectionsStore } from "../src/store/connections";

it.each(["unpaired", "re-pair", "rejected"] as const)(
  "Re-pair after %s clears the old pairing so the computer's QR code can be scanned",
  async (error) => {
    vi.clearAllMocks();
    useComputersStore.setState({
      computers: [
        {
          fp: "computer",
          name: "Test computer",
          accent: "emerald",
          relayUrl: "wss://relay.example",
          pairedAt: "2026-01-01T00:00:00Z",
          lastSeenAt: null,
          pushEnabled: false,
        },
      ],
    });
    useConnectionsStore.setState({ byComputer: {} });
    useConnectionsStore.getState().patch("computer", () => ({ status: "error", error }));
    const root = createRoot();
    try {
      await act(async () => root.render(createElement(Computer)));
      const empty = root.container.queryAll((node) => node.type === "EmptyState")[0]!;
      expect(empty.props.action.label).toBe("Re-pair");
      await act(async () => empty.props.action.onPress());
      const choices = (platform.alert.mock.calls[0]?.[2] ?? []) as Array<{
        text: string;
        onPress?: () => Promise<void>;
      }>;
      await act(async () => choices.find((choice) => choice.text === "Re-pair")?.onPress?.());
      // The pairing screen refuses any QR code whose computer still has a record here.
      expect(useComputersStore.getState().computers.some((c) => c.fp === "computer")).toBe(false);
      expect(platform.deletePairSecret).toHaveBeenCalledExactlyOnceWith("computer");
      expect(platform.replace).toHaveBeenCalledExactlyOnceWith("/pair");
    } finally {
      await act(async () => root.unmount());
    }
  },
);
