import { act, createElement } from "react";
import { createRoot } from "test-renderer";
import { expect, it, vi } from "vitest";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const motion = vi.hoisted(() => ({ reduced: false, repeat: vi.fn((value: unknown) => value) }));
vi.mock("react-native-reanimated", async () => {
  const React = await import("react");
  return {
    default: { View: "AnimatedView" },
    useReducedMotion: () => motion.reduced,
    useSharedValue: (value: unknown) => React.useRef({ value }).current,
    useAnimatedStyle: (evaluate: () => object) => evaluate(),
    withRepeat: motion.repeat,
    withTiming: (value: unknown) => value,
    cancelAnimation: vi.fn(),
    Easing: { inOut: () => undefined, ease: undefined },
    FadeIn: { duration: () => ({ reduceMotion: () => "fade-in" }) },
    FadeOut: { duration: () => ({ reduceMotion: () => "fade-out" }) },
    FadeInDown: {
      duration: (ms: number) => ({ reduceMotion: (mode: string) => `rise-${ms}-${mode}` }),
    },
    ZoomIn: {
      duration: (ms: number) => ({ reduceMotion: (mode: string) => `zoom-${ms}-${mode}` }),
    },
    LinearTransition: {
      duration: (ms: number) => ({ reduceMotion: (mode: string) => `layout-${ms}-${mode}` }),
    },
    ReduceMotion: { System: "system" },
  };
});

const { BreathingDot, CheckIn, Fade, Resizes, RiseIn } = await import("../src/conversation/motion");

it("breathes on the UI thread, and stands still with Reduce Motion on", async () => {
  const root = createRoot();
  await act(async () => root.render(createElement(BreathingDot, { color: "#D97757" })));
  expect(motion.repeat).toHaveBeenCalledOnce();
  motion.repeat.mockClear();
  motion.reduced = true;
  await act(async () => root.render(createElement(BreathingDot, { color: "#D97757" })));
  expect(motion.repeat).not.toHaveBeenCalled();
  const dot = root.container.queryAll((n) => n.type === "AnimatedView")[0]!;
  expect(dot.props.style[1]).toMatchObject({ opacity: 1 });
  await act(async () => root.unmount());
});

it("fades receipts in and out under the system's Reduce Motion setting", async () => {
  const root = createRoot();
  await act(async () => root.render(createElement(Fade, null)));
  const view = root.container.queryAll((n) => n.type === "AnimatedView")[0]!;
  expect(view.props).toMatchObject({ entering: "fade-in", exiting: "fade-out" });
  await act(async () => root.unmount());
});

it("rises rows, pops the check and resizes cards in 150 ms, all under Reduce Motion", async () => {
  const root = createRoot();
  await act(async () =>
    root.render(
      createElement(
        "View",
        null,
        createElement(RiseIn, { rise: true }, null),
        createElement(CheckIn, null, null),
        createElement(Resizes, null, null),
      ),
    ),
  );
  const views = root.container.queryAll((n) => n.type === "AnimatedView");
  expect(views.map((n) => n.props.entering ?? n.props.layout)).toEqual([
    "rise-150-system",
    "zoom-150-system",
    "layout-150-system",
  ]);
  await act(async () => root.unmount());
});
