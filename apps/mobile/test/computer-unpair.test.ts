import {
  decodeEnvelope,
  type Envelope,
  fingerprint,
  generateIdentity,
  parseCtrlLoose,
} from "@shellbell/protocol";
import { act, createElement } from "react";
import { createRoot } from "test-renderer";
import { afterEach, expect, it, vi } from "vitest";

const platform = vi.hoisted(() => ({
  fp: "",
  alert: vi.fn(),
  replace: vi.fn(),
  loadPairSecret: vi.fn(),
  loadExistingIdentity: vi.fn(),
  deletePairSecret: vi.fn(),
  putRevocation: vi.fn(),
}));
vi.mock("react-native", () => ({
  Alert: { alert: platform.alert },
  AppState: { currentState: "active", addEventListener: () => ({ remove() {} }) },
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  Switch: "Switch",
  Text: "Text",
  View: "View",
}));
vi.mock("expo-router", () => ({
  useLocalSearchParams: () => ({ fp: platform.fp }),
  useRouter: () => ({ replace: platform.replace }),
}));
vi.mock("expo-sqlite/kv-store", () => ({
  default: { getItemSync: () => null, setItemSync() {} },
}));
vi.mock("../src/components/RelaySetting", () => ({ RelaySetting: "RelaySetting" }));
vi.mock("../src/identity/keys", () => ({
  loadPairSecret: platform.loadPairSecret,
  loadExistingIdentity: platform.loadExistingIdentity,
  deletePairSecret: platform.deletePairSecret,
  migrateStoredKeys: async () => {},
}));
vi.mock("../src/net/revocation-retry", () => ({
  durableRevocationOutbox: () => ({ put: platform.putRevocation }),
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

import ComputerSettings from "../app/c/[fp]/settings";
import { connectionManager } from "../src/net/manager";
import { useComputersStore } from "../src/store/computers";
import { useConnectionsStore } from "../src/store/connections";

class Socket {
  static instances: Socket[] = [];
  binaryType = "";
  readyState = 1;
  frames: Envelope[] = [];
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  constructor() {
    Socket.instances.push(this);
  }
  send(data: ArrayBuffer | Uint8Array | string) {
    if (this.readyState !== 1 || typeof data === "string") throw new Error("socket unavailable");
    this.frames.push(decodeEnvelope(data instanceof Uint8Array ? data : new Uint8Array(data)));
  }
  close() {
    this.readyState = 3;
    this.onclose?.({ code: 1000, reason: "" });
  }
}

afterEach(() => {
  connectionManager.stop();
  vi.unstubAllGlobals();
});

it.each([1, 2] as const)(
  "sends v%s unpair before the real manager closes the tombstoned computer's socket",
  async (minProtocolVersion) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("WebSocket", Socket);
    vi.clearAllMocks();
    Socket.instances.length = 0;
    const identity = generateIdentity();
    const computer = generateIdentity();
    platform.fp = fingerprint(computer.ed25519.pub);
    platform.loadPairSecret.mockResolvedValue({
      kPair: new Uint8Array(32).fill(7),
      computerEd25519Pub: computer.ed25519.pub,
      computerX25519Pub: computer.x25519.pub,
      minProtocolVersion,
    });
    platform.loadExistingIdentity.mockResolvedValue({
      identity,
      fp: fingerprint(identity.ed25519.pub),
    });
    useComputersStore.setState({
      computers: [
        {
          fp: platform.fp,
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
    connectionManager.start({
      identity,
      phoneFp: fingerprint(identity.ed25519.pub),
      phoneName: "Test phone",
      appVersion: "test",
      direct: false,
      pushToken: async () => null,
    });
    await vi.waitFor(() => expect(Socket.instances).toHaveLength(1));
    const socket = Socket.instances[0]!;
    const root = createRoot();
    try {
      await act(async () => root.render(createElement(ComputerSettings)));
      const unpair = root.container.queryAll(
        (node) => node.type === "Text" && node.props.children === "Unpair",
      )[0]!;
      await act(async () => unpair.parent!.props.onPress());
      const choices = platform.alert.mock.calls[0]![2] as Array<{
        text: string;
        onPress?: () => Promise<void>;
      }>;
      await act(async () => choices.find((choice) => choice.text === "Unpair")!.onPress!());
      expect(
        socket.frames.filter(
          (frame) => frame.t === "ctrl" && parseCtrlLoose(frame.body).type === "unpair",
        ),
      ).toHaveLength(1);
      expect(socket.readyState).toBe(3);
      expect(connectionManager.get(platform.fp)).toBeUndefined();
      expect(useComputersStore.getState().computers).toEqual([]);
      expect(platform.deletePairSecret).toHaveBeenCalledExactlyOnceWith(platform.fp);
      expect(platform.putRevocation).toHaveBeenCalledTimes(minProtocolVersion === 2 ? 1 : 0);
      expect(platform.replace).toHaveBeenCalledExactlyOnceWith("/");
    } finally {
      await act(async () => root.unmount());
    }
  },
);
