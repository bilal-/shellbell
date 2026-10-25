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
import { hasAcceptedRelay } from "../src/store/consent";
import { consentStorage, resetConsentStorage } from "./helpers/consent-storage";

vi.mock("expo-sqlite/kv-store", async () => ({
  default: (await import("./helpers/consent-storage")).consentStorage,
}));

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
  alert: vi.fn(),
  permission: { granted: true, canAskAgain: true },
  refresh: vi.fn().mockResolvedValue(undefined),
  identity: vi.fn(),
  parse: vi.fn(),
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
  selectionAsync: flow.haptic,
  NotificationFeedbackType: { Success: "success" },
}));
vi.mock("expo-router", () => ({ useRouter: () => ({ replace: flow.replace }) }));
vi.mock("react-native", () => ({
  View: "View",
  Text: "Text",
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  ActivityIndicator: "ActivityIndicator",
  Alert: { alert: flow.alert },
  Platform: { OS: "android" },
  Linking: {},
  AppState: { addEventListener: () => ({ remove: vi.fn() }) },
}));
vi.mock("../src/identity/keys", () => ({
  loadOrCreateIdentity: flow.identity,
  savePairSecret: flow.save,
}));
vi.mock("../src/net/pairing", async (original) => {
  const actual = await original<typeof import("../src/net/pairing")>();
  flow.parse.mockImplementation(actual.parsePairingQr);
  return { ...actual, runPairing: flow.run, parsePairingQr: flow.parse };
});
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
  resetConsentStorage();
  vi.clearAllMocks();
  flow.save.mockResolvedValue(undefined);
  flow.identity.mockResolvedValue({ identity: {}, fp: "phone" });
  flow.parse.mockClear();
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

function camera(root: ReturnType<typeof createRoot>) {
  return root.container.queryAll((node) => node.type === "CameraView")[0];
}
async function press(root: ReturnType<typeof createRoot>, label: string) {
  await act(async () => {
    button(root, label).props.onPress();
  });
}
async function render() {
  const root = createRoot();
  await act(async () => root.render(createElement(PairScreen)));
  return root;
}
const paired = (fp: string) =>
  ({
    computerFp: fp,
    computerName: "Demo Computer",
    accent: "emerald",
    relayUrl: "wss://relay.shellbell.dev",
    secret: {},
  }) as PairingResult;

it("turns the camera off once a code is read, and counts Pair computer as relay consent", async () => {
  const root = await render();
  try {
    const code = qr("wss://private.example.com");
    await scan(root, code.data);
    expect(camera(root)).toBeUndefined();
    expect(text(root)).toContain("Demo Computer");
    expect(text(root)).toContain("wss://private.example.com");
    expect(text(root)).toContain("may log or retain it");
    expect(flow.run).not.toHaveBeenCalled();
    await press(root, "Pair computer");
    // The card already showed the relay notice, so no second prompt.
    expect(flow.alert).not.toHaveBeenCalled();
    expect(hasAcceptedRelay("wss://private.example.com")).toBe(true);
    expect(flow.run).toHaveBeenCalledTimes(1);
    expect(text(root)).toContain("Connecting to your computer");
    await act(async () => flow.run.mock.calls[0]![0].onProgress("awaiting-approval"));
    expect(text(root)).toContain("Waiting for your computer to approve");
    expect(text(root)).toContain("Approve this phone on Demo Computer");
    expect(text(root)).toContain("Allow only if your computer shows the same fingerprint");
    await press(root, "Stop");
    expect(text(root)).toContain("Stopped waiting on this phone");
    expect(text(root)).toContain("Decline the request on your computer");
    expect(camera(root)).toBeUndefined();
    await press(root, "Scan again");
    expect(camera(root)).toBeDefined();
    await scan(root, code.data);
    expect(text(root)).toContain("Pair computer");
    expect(flow.run).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
  }
});

it("cancels a pending connection when the pairing screen closes", async () => {
  const root = await render();
  await scan(root, qr().data);
  await press(root, "Pair computer");
  const signal = flow.run.mock.calls[0]![0].signal as AbortSignal;
  await act(async () => root.unmount());
  expect(signal.aborted).toBe(true);
  expect(flow.save).not.toHaveBeenCalled();
  expect(flow.replace).not.toHaveBeenCalled();
});

it("does not connect when the relay choice can't be saved", async () => {
  const root = await render();
  try {
    await scan(root, qr("wss://private.example.com").data);
    consentStorage.setItemSync.mockImplementation(() => {
      throw new Error("locked");
    });
    await press(root, "Pair computer");
    expect(text(root)).toContain("Could not save your relay choice");
    expect(flow.run).not.toHaveBeenCalled();
    expect(hasAcceptedRelay("wss://private.example.com")).toBe(false);
    expect(button(root, "Pair computer")).toBeDefined();
  } finally {
    await act(async () => root.unmount());
  }
});

it("keeps a completed pairing when success vibration is unavailable", async () => {
  const code = qr();
  flow.haptic.mockRejectedValue(new Error("no vibrator"));
  flow.run.mockResolvedValue(paired(code.fp));
  const root = await render();
  try {
    await scan(root, code.data);
    await press(root, "Pair computer");
    expect(flow.save).toHaveBeenCalledTimes(1);
    expect(flow.add).toHaveBeenCalledTimes(1);
    expect(flow.replace).toHaveBeenCalledWith(`/c/${code.fp}`);
  } finally {
    await act(async () => root.unmount());
  }
});

it("keeps scanning past a code that isn't a pairing code, without reacting to it again", async () => {
  const root = await render();
  try {
    await scan(root, "https://example.com");
    expect(camera(root)).toBeDefined();
    expect(text(root)).toContain("That isn't a Shellbell pairing code");
    expect(flow.haptic).not.toHaveBeenCalled();
    await scan(root, "https://example.com");
    await scan(root, "https://example.com");
    expect(camera(root)).toBeDefined();
    // The same wrong code, held in view, is read once.
    expect(flow.parse).toHaveBeenCalledTimes(1);
    await scan(root, qr().data);
    expect(flow.parse).toHaveBeenCalledTimes(2);
    expect(camera(root)).toBeUndefined();
    expect(text(root)).toContain("Pair computer");
  } finally {
    await act(async () => root.unmount());
  }
});

it("catches a code past its closing time before connecting", async () => {
  const root = await render();
  try {
    const code = JSON.parse(qr().data) as Record<string, unknown>;
    await scan(root, JSON.stringify({ ...code, x: Math.floor(Date.now() / 1000) - 3600 }));
    expect(text(root)).toContain("This code is no longer active");
    expect(text(root)).toContain("shellbell pair");
    expect(flow.run).not.toHaveBeenCalled();
    await press(root, "Scan new code");
    expect(camera(root)).toBeDefined();
  } finally {
    await act(async () => root.unmount());
  }
});

it("opens a computer this phone already paired", async () => {
  const root = await render();
  try {
    const code = qr();
    const { useComputersStore } = await import("../src/store/computers");
    useComputersStore.getState().computers.push({ fp: code.fp } as never);
    await scan(root, code.data);
    expect(text(root)).toContain("You already paired this computer");
    await press(root, "Open it");
    expect(flow.replace).toHaveBeenCalledWith(`/c/${code.fp}`);
    expect(flow.run).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
  }
});

it("tries the same code again twice while the computer is offline, then asks for a new code", async () => {
  flow.run.mockRejectedValue(new PairingError("no-agent"));
  const root = await render();
  try {
    await scan(root, qr().data);
    await press(root, "Pair computer");
    expect(text(root)).toContain("Your computer isn't connected to Shellbell right now");
    await press(root, "Try again");
    await press(root, "Try again");
    expect(flow.run).toHaveBeenCalledTimes(3);
    expect(() => button(root, "Try again")).toThrow();
    await press(root, "Scan new code");
    expect(camera(root)).toBeDefined();
  } finally {
    await act(async () => root.unmount());
  }
});

it("never retries once the request may still be waiting on the computer", async () => {
  flow.run.mockRejectedValue(new PairingError("relay", true));
  const root = await render();
  try {
    await scan(root, qr().data);
    await press(root, "Pair computer");
    expect(text(root)).toContain("Pairing may still be waiting on your computer");
    expect(text(root)).toContain("decline it, then scan a new code");
    expect(() => button(root, "Try again")).toThrow();
    expect(button(root, "Scan new code")).toBeDefined();
  } finally {
    await act(async () => root.unmount());
  }
});

it("saves an approved pairing again without a new request", async () => {
  const code = qr();
  flow.run.mockResolvedValue(paired(code.fp));
  flow.save.mockRejectedValueOnce(new Error("keystore busy"));
  const root = await render();
  try {
    await scan(root, code.data);
    await press(root, "Pair computer");
    expect(text(root)).toContain("Couldn't save this computer");
    await press(root, "Try saving again");
    expect(flow.run).toHaveBeenCalledTimes(1);
    expect(flow.save).toHaveBeenCalledTimes(2);
    expect(flow.replace).toHaveBeenCalledWith(`/c/${code.fp}`);
  } finally {
    await act(async () => root.unmount());
  }
});

it("offers to start the camera again when it fails", async () => {
  const root = await render();
  try {
    await act(async () => camera(root)!.props.onMountError({ message: "busy" }));
    expect(text(root)).toContain("The camera couldn't start");
    await press(root, "Try again");
    expect(camera(root)).toBeDefined();
  } finally {
    await act(async () => root.unmount());
  }
});

it("explains a busy pairing prompt as well as a full paired-device list", async () => {
  flow.run.mockRejectedValue(new PairingError("too-many"));
  const root = await render();
  try {
    await scan(root, qr().data);
    await press(root, "Pair computer");
    expect(text(root)).toContain("Decline any waiting request on your computer");
    expect(text(root)).toContain("remove a phone you no longer use there");
  } finally {
    await act(async () => root.unmount());
  }
});

it("stops at once while this phone's identity is still loading", async () => {
  flow.identity.mockReturnValue(new Promise(() => {}));
  const root = await render();
  try {
    await scan(root, qr().data);
    await press(root, "Pair computer");
    await press(root, "Stop");
    expect(text(root)).toContain("Stopped waiting on this phone");
    expect(flow.run).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
  }
});

it("drops an attempt when a different code is chosen before the screen changes", async () => {
  const code = qr();
  let finish!: (result: PairingResult) => void;
  flow.run.mockReturnValue(
    new Promise<PairingResult>((resolve) => {
      finish = resolve;
    }),
  );
  const root = await render();
  try {
    await scan(root, code.data);
    const pairButton = button(root, "Pair computer");
    const different = button(root, "Scan a different code");
    await act(async () => {
      pairButton.props.onPress();
      different.props.onPress();
    });
    await act(async () => finish(paired(code.fp)));
    expect(flow.save).not.toHaveBeenCalled();
    expect(camera(root)).toBeDefined();
  } finally {
    await act(async () => root.unmount());
  }
});

it("saves only once when Try saving again is pressed twice", async () => {
  const code = qr();
  flow.run.mockResolvedValue(paired(code.fp));
  flow.save.mockRejectedValueOnce(new Error("keystore busy"));
  const root = await render();
  try {
    await scan(root, code.data);
    await press(root, "Pair computer");
    const again = button(root, "Try saving again");
    await act(async () => {
      again.props.onPress();
      again.props.onPress();
    });
    expect(flow.save).toHaveBeenCalledTimes(2);
    expect(flow.replace).toHaveBeenCalledWith(`/c/${code.fp}`);
    expect(text(root)).not.toContain("You already paired this computer");
  } finally {
    await act(async () => root.unmount());
  }
});

it("keeps counting retries when the same code is scanned again", async () => {
  flow.run.mockRejectedValue(new PairingError("no-agent"));
  const code = qr();
  const root = await render();
  try {
    await scan(root, code.data);
    await press(root, "Pair computer");
    await press(root, "Try again");
    await press(root, "Try again");
    await press(root, "Scan new code");
    await scan(root, code.data);
    await press(root, "Pair computer");
    expect(flow.run).toHaveBeenCalledTimes(4);
    expect(() => button(root, "Try again")).toThrow();
  } finally {
    await act(async () => root.unmount());
  }
});

it("spends no retry on a double tap that started nothing", async () => {
  let fail!: () => void;
  flow.run.mockRejectedValueOnce(new PairingError("no-agent"));
  flow.run.mockReturnValueOnce(
    new Promise((_resolve, reject) => {
      fail = () => reject(new PairingError("no-agent"));
    }),
  );
  const root = await render();
  try {
    await scan(root, qr().data);
    await press(root, "Pair computer");
    const again = button(root, "Try again");
    await act(async () => {
      again.props.onPress();
      again.props.onPress();
    });
    expect(flow.run).toHaveBeenCalledTimes(2);
    await act(async () => fail());
    // One retry was used, so one is left.
    expect(button(root, "Try again")).toBeDefined();
  } finally {
    await act(async () => root.unmount());
  }
});
