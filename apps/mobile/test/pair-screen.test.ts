import {
  encodeQr,
  fingerprint,
  generateIdentity,
  randomBytes,
  toBase64Url,
} from "@shellbell/protocol";
import { act, createElement, type Ref } from "react";
import { createRoot } from "test-renderer";
import { beforeEach, expect, it, vi } from "vitest";
import PairScreen from "../app/pair";
import { PairingError, type PairingResult, type runPairing } from "../src/net/pairing";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
vi.stubGlobal("__DEV__", false);
const flow = vi.hoisted(() => ({
  pause: vi.fn().mockResolvedValue(undefined),
  run: vi.fn(),
  add: vi.fn(),
  save: vi.fn(),
  replace: vi.fn(),
  haptic: vi.fn(),
  permission: { granted: true, canAskAgain: true },
  refresh: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("expo-camera", async () => {
  const { createElement, useImperativeHandle } = await import("react");
  return {
    CameraView: ({ ref, ...props }: { ref?: Ref<unknown> }) => {
      useImperativeHandle(ref, () => ({ pausePreview: flow.pause }));
      return createElement("CameraView", props);
    },
    useCameraPermissions: () => [flow.permission, vi.fn(), flow.refresh],
  };
});
vi.mock("expo-constants", () => ({ default: { expoConfig: { version: "1.1.0" } } }));
vi.mock("expo-device", () => ({ deviceName: "Demo phone" }));
vi.mock("expo-haptics", () => ({
  notificationAsync: flow.haptic,
  NotificationFeedbackType: { Success: "success" },
}));
vi.mock("expo-router", () => ({ useRouter: () => ({ replace: flow.replace }) }));
vi.mock("react-native", () => ({
  View: "View",
  Text: "Text",
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  ActivityIndicator: "ActivityIndicator",
  Alert: { alert: vi.fn() },
  Platform: { OS: "android" },
  Linking: {},
  AppState: { addEventListener: () => ({ remove: vi.fn() }) },
}));
vi.mock("../src/identity/keys", () => ({
  loadOrCreateIdentity: async () => ({ identity: {}, fp: "phone" }),
  savePairSecret: flow.save,
}));
vi.mock("../src/net/pairing", async (original) => ({
  ...(await original<object>()),
  runPairing: flow.run,
}));
vi.mock("../src/notifications", () => ({
  registerPushTokenWhenConnected: vi.fn(),
  requestPermissionOnce: vi.fn(),
}));
vi.mock("../src/store/computers", () => {
  const state = { add: flow.add, computers: [{ fp: "already-paired-other-computer" }] };
  return {
    useComputersStore: Object.assign(
      (selector: (value: typeof state) => unknown) => selector(state),
      { getState: () => state },
    ),
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  flow.save.mockResolvedValue(undefined);
  flow.haptic.mockResolvedValue(undefined);
  flow.run.mockImplementation(
    (options: Parameters<typeof runPairing>[0]) =>
      new Promise((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => reject(new PairingError("cancelled")), {
          once: true,
        });
      }),
  );
});

function qr(relay = "wss://relay.shellbell.dev") {
  const computer = generateIdentity();
  const fp = fingerprint(computer.ed25519.pub);
  return {
    fp,
    data: encodeQr({
      v: 1,
      r: relay,
      c: fp,
      e: toBase64Url(computer.ed25519.pub),
      n: "Demo Computer",
      p: toBase64Url(randomBytes(16)),
      g: toBase64Url(randomBytes(16)),
    }),
  };
}
function text(root: ReturnType<typeof createRoot>) {
  return root.container
    .queryAll((node) => node.type === "Text")
    .map((node) => [node.props.children].flat().join(""))
    .join(" ");
}
function button(root: ReturnType<typeof createRoot>, label: string) {
  const found = root.container
    .queryAll((node) => node.type === "Pressable")
    .find((node) => node.props.children.props.children === label);
  if (!found) throw new Error(`Missing button ${label}`);
  return found;
}
async function scan(root: ReturnType<typeof createRoot>, data: string) {
  await act(async () =>
    root.container
      .queryAll((node) => node.type === "CameraView")[0]!
      .props.onBarcodeScanned({ data }),
  );
}

it("captures once, shows custom relay disclosure, and waits for explicit confirmation before connecting", async () => {
  const root = createRoot();
  try {
    await act(async () => root.render(createElement(PairScreen)));
    const code = qr("wss://private.example.com");
    await scan(root, code.data);
    expect(text(root)).toContain("Code captured");
    expect(text(root)).toContain("wss://private.example.com");
    expect(text(root)).toContain("may log or retain it");
    expect(flow.run).not.toHaveBeenCalled();
    expect(
      root.container.queryAll((node) => node.type === "CameraView")[0]!.props.onBarcodeScanned,
    ).toBeUndefined();
    await act(async () => {
      button(root, "Pair computer").props.onPress();
    });
    expect(flow.run).toHaveBeenCalledTimes(1);
    expect(text(root)).toContain("Connecting to your computer");
    expect(text(root)).not.toContain("Waiting for computer approval");
    await act(async () => flow.run.mock.calls[0]![0].onProgress("awaiting-approval"));
    expect(text(root)).toContain("Waiting for computer approval");
    expect(text(root)).toContain("To stop pairing, decline the request on your computer");
    expect(text(root)).toContain("Approve this device in Shellbell on Demo Computer");
    await act(async () => button(root, "Stop waiting").props.onPress());
    expect(text(root)).toContain("Stopped waiting on this device");
    expect(text(root)).toContain(
      "If you already approved it, remove this device on the computer before trying again",
    );
    expect(flow.add).not.toHaveBeenCalled();
    await act(async () => button(root, "Scan again").props.onPress());
    await scan(root, code.data);
    expect(text(root)).toContain("Code captured");
    expect(flow.run).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
  }
});

it("cancels a pending connection when the pairing screen closes", async () => {
  const root = createRoot();
  await act(async () => root.render(createElement(PairScreen)));
  await scan(root, qr().data);
  await act(async () => {
    button(root, "Pair computer").props.onPress();
  });
  const signal = flow.run.mock.calls[0]![0].signal as AbortSignal;
  await act(async () => root.unmount());
  expect(signal.aborted).toBe(true);
  expect(flow.save).not.toHaveBeenCalled();
  expect(flow.replace).not.toHaveBeenCalled();
});

it("keeps a completed pairing when success vibration is unavailable", async () => {
  const root = createRoot();
  const code = qr();
  flow.haptic.mockRejectedValue(new Error("no vibrator"));
  flow.run.mockResolvedValue({
    computerFp: code.fp,
    computerName: "Demo Computer",
    accent: "emerald",
    relayUrl: "wss://relay.shellbell.dev",
    secret: {},
  } as PairingResult);
  try {
    await act(async () => root.render(createElement(PairScreen)));
    await scan(root, code.data);
    await act(async () => {
      button(root, "Pair computer").props.onPress();
    });
    expect(flow.save).toHaveBeenCalledTimes(1);
    expect(flow.add).toHaveBeenCalledTimes(1);
    expect(flow.replace).toHaveBeenCalledWith(`/c/${code.fp}`);
    expect(text(root)).not.toContain("Couldn't reach the relay");
  } finally {
    await act(async () => root.unmount());
  }
});

it("explains a busy pairing prompt as well as a full paired-device list", async () => {
  const root = createRoot();
  flow.run.mockRejectedValue(new PairingError("too-many"));
  try {
    await act(async () => root.render(createElement(PairScreen)));
    await scan(root, qr().data);
    await act(async () => {
      button(root, "Pair computer").props.onPress();
    });
    expect(text(root)).toContain("Decline any pending request or remove an unused paired device");
  } finally {
    await act(async () => root.unmount());
  }
});
