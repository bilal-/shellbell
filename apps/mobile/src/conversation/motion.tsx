import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  FadeIn,
  FadeInDown,
  FadeOut,
  LinearTransition,
  ReduceMotion,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
  ZoomIn,
} from "react-native-reanimated";

/**
 * Chat's motion, all on the UI thread so it never competes with conversation updates. With the
 * system's Reduce Motion on, every piece here stands still.
 */

/** A dot that breathes while something is happening: 1.6 s in and out, as in the mockup. */
export function BreathingDot({ color, size = 10 }: { color: string; size?: number }) {
  const still = useReducedMotion();
  const phase = useSharedValue(1);
  useEffect(() => {
    if (still) {
      cancelAnimation(phase);
      phase.value = 1;
      return;
    }
    phase.value = 0;
    phase.value = withRepeat(
      withTiming(1, { duration: 800, easing: Easing.inOut(Easing.ease) }),
      -1,
      true,
    );
    return () => cancelAnimation(phase);
  }, [still, phase]);
  const style = useAnimatedStyle(() => ({
    opacity: 0.6 + 0.4 * phase.value,
    transform: [{ scale: 0.75 + 0.25 * phase.value }],
  }));
  return (
    <Animated.View
      accessible={false}
      importantForAccessibility="no"
      style={[{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }, style]}
    />
  );
}

/** Fades in when it appears and out when it goes, or simply appears with Reduce Motion. */
export function Fade({
  children,
  style,
  inMs = 150,
  outMs = 300,
  pointerEvents,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  inMs?: number;
  outMs?: number;
  pointerEvents?: "auto" | "none";
}) {
  return (
    <Animated.View
      entering={FadeIn.duration(inMs).reduceMotion(ReduceMotion.System)}
      exiting={FadeOut.duration(outMs).reduceMotion(ReduceMotion.System)}
      pointerEvents={pointerEvents}
      style={style}
    >
      {children}
    </Animated.View>
  );
}

/**
 * A row that just arrived live fades in and rises into place over 150 ms. Whether it rises is
 * decided when it mounts, so the same wrapper stays around the row afterwards and the row is
 * never mounted again (which would lose its state, such as an opened card).
 */
export function RiseIn({ rise, children }: { rise: boolean; children?: ReactNode }) {
  const [rises] = useState(rise);
  if (!rises) return children;
  return (
    <Animated.View entering={FadeInDown.duration(150).reduceMotion(ReduceMotion.System)}>
      {children}
    </Animated.View>
  );
}

/**
 * Content that opens under a step: it fades in as its card grows to fit, and the card shrinks
 * back as it closes. The card itself takes `layoutTransition`.
 */
export function Expand({ children }: { children: ReactNode }) {
  return (
    <Animated.View
      entering={FadeIn.duration(150).reduceMotion(ReduceMotion.System)}
      exiting={FadeOut.duration(100).reduceMotion(ReduceMotion.System)}
    >
      {children}
    </Animated.View>
  );
}

/** A view whose height follows its content smoothly, for cards that expand. */
export function Resizes({
  children,
  style,
  testID,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  return (
    <Animated.View
      testID={testID}
      layout={LinearTransition.duration(150).reduceMotion(ReduceMotion.System)}
      style={style}
    >
      {children}
    </Animated.View>
  );
}

/** The receipt's check: it pops in once the computer confirms. */
export function CheckIn({ children }: { children: ReactNode }) {
  return (
    <Animated.View entering={ZoomIn.duration(150).reduceMotion(ReduceMotion.System)}>
      {children}
    </Animated.View>
  );
}
