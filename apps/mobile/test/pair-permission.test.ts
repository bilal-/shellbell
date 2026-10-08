import { act, createElement } from "react";
import { createRoot } from "test-renderer";
import { beforeEach, expect, it, vi } from "vitest";
import PairScreen from "../app/pair";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
const camera = vi.hoisted(() => ({
  permission: { granted: false, canAskAgain: false },
  request: vi.fn(),
  refresh: vi.fn(),
  settings: vi.fn(),
  foreground: (_state: string) => {},
  remove: vi.fn(),
}));
vi.mock("expo-camera", () => ({
  CameraView: "CameraView",
  useCameraPermissions: () => [camera.permission, camera.request, camera.refresh],
}));
vi.mock("expo-constants", () => ({ default: { expoConfig: { version: "1.1.0" } } }));
vi.mock("expo-device", () => ({}));
vi.mock("expo-haptics", () => ({}));
vi.mock("expo-router", () => ({ useRouter: () => ({}) }));
vi.mock("react-native", () => ({
  View: "View",
  Text: "Text",
  Pressable: "Pressable",
  Alert: {},
  Platform: { OS: "ios" },
  Linking: { openSettings: camera.settings },
  AppState: {
    addEventListener: (_event: string, handler: (state: string) => void) => {
      camera.foreground = handler;
      return { remove: camera.remove };
    },
  },
}));
vi.mock("../src/identity/keys", () => ({}));
vi.mock("../src/net/pairing", () => ({}));
vi.mock("../src/notifications", () => ({}));
vi.mock("../src/notifications/cleanup", () => ({}));
vi.mock("../src/store/computers", () => ({
  useComputersStore: (selector: (state: object) => unknown) => selector({ add: vi.fn() }),
}));

beforeEach(() => {
  camera.permission = { granted: false, canAskAgain: false };
  camera.request.mockReset().mockResolvedValue(undefined);
  camera.refresh.mockReset().mockResolvedValue(undefined);
  camera.settings.mockReset().mockResolvedValue(undefined);
  camera.remove.mockReset();
});

it("opens system settings after permanent denial and refreshes permission on return", async () => {
  const root = createRoot();
  try {
    await act(async () => root.render(createElement(PairScreen)));
    expect(
      root.container.queryAll((node) => node.type === "Text").map((node) => node.props.children),
    ).toContain("Open Settings");
    await act(async () =>
      root.container.queryAll((node) => node.type === "Pressable")[0]!.props.onPress(),
    );
    expect(camera.settings).toHaveBeenCalledTimes(1);
    expect(camera.request).not.toHaveBeenCalled();
    await act(async () => camera.foreground("active"));
    expect(camera.refresh).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
  }
  expect(camera.remove).toHaveBeenCalledTimes(1);
});

it("requests camera access normally while the system still allows a prompt", async () => {
  camera.permission = { granted: false, canAskAgain: true };
  const root = createRoot();
  try {
    await act(async () => root.render(createElement(PairScreen)));
    await act(async () =>
      root.container.queryAll((node) => node.type === "Pressable")[0]!.props.onPress(),
    );
    expect(camera.request).toHaveBeenCalledTimes(1);
    expect(camera.settings).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
  }
});
