import { vi } from "vitest";

/** Native/animation boundaries only; the library's geometry code runs unchanged. */
const keyboardLayout = vi.hoisted(() => ({
  windowHeight: 800,
  nativeY: 100,
  headerHeight: 100,
  nativeX: 0,
  rejectMeasurement: false,
  keyboardHeight: 300,
  progress: 1,
}));

export { keyboardLayout };

vi.mock("expo-router/react-navigation", () => ({
  useHeaderHeight: () => keyboardLayout.headerHeight,
}));

vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 40, bottom: 34, left: 24, right: 18 }),
}));

vi.mock("react-native", async () => {
  const React = await import("react");
  const View = React.forwardRef<unknown, { children?: import("react").ReactNode }>((props, ref) => {
    React.useImperativeHandle(ref, () => ({ nativeTag: 7 }), []);
    return React.createElement("NativeView", props);
  });
  return {
    View,
    Text: "NativeText",
    Pressable: "NativePressable",
    ActivityIndicator: "ActivityIndicator",
    Alert: { alert: vi.fn() },
  };
});

vi.mock("react-native-reanimated", async () => {
  const React = await import("react");
  const { View } = await import("react-native");
  return {
    default: { View },
    useSharedValue: (value: unknown) => React.useRef({ value }).current,
    useDerivedValue: (evaluate: () => unknown) => ({
      get value() {
        return evaluate();
      },
    }),
    useAnimatedStyle: (evaluate: () => Record<string, unknown>) =>
      new Proxy({}, { get: (_target, key) => evaluate()[String(key)] }),
    runOnUI: (callback: (...args: unknown[]) => unknown) => callback,
    interpolate: (value: number, input: number[], output: number[]) =>
      output[0]! + ((value - input[0]!) / (input[1]! - input[0]!)) * (output[1]! - output[0]!),
  };
});

vi.mock("react-native-keyboard-controller/src/bindings", () => ({
  KeyboardControllerNative: {
    viewPositionInWindow: async () => {
      if (keyboardLayout.rejectMeasurement) throw new Error("native measurement unavailable");
      return { x: keyboardLayout.nativeX, y: keyboardLayout.nativeY };
    },
  },
}));
vi.mock("react-native-keyboard-controller/src/hooks", () => ({
  useWindowDimensions: () => ({ width: 400, height: keyboardLayout.windowHeight }),
}));
vi.mock("react-native-keyboard-controller/src/utils/findNodeHandle", () => ({
  findNodeHandle: () => 7,
}));
vi.mock("react-native-keyboard-controller/src/components/KeyboardAvoidingView/hooks", () => ({
  useKeyboardAnimation: () => ({
    heightWhenOpened: {
      get value() {
        return keyboardLayout.keyboardHeight;
      },
    },
    progress: {
      get value() {
        return keyboardLayout.progress;
      },
    },
    isClosed: {
      get value() {
        return keyboardLayout.progress === 0;
      },
    },
  }),
  useTranslateAnimation: () => ({ translate: { value: 0 }, padding: { value: 0 } }),
}));
vi.mock("react-native-keyboard-controller", async () => {
  const source = await vi.importActual<{ default: import("react").ComponentType }>(
    "react-native-keyboard-controller/src/components/KeyboardAvoidingView/index.tsx",
  );
  return { KeyboardAvoidingView: source.default };
});
