import type { ReactNode } from "react";
import { useEffect } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  FadeIn,
  FadeOut,
  ReduceMotion,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
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
export function Fade({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return (
    <Animated.View
      entering={FadeIn.duration(150).reduceMotion(ReduceMotion.System)}
      exiting={FadeOut.duration(300).reduceMotion(ReduceMotion.System)}
      style={style}
    >
      {children}
    </Animated.View>
  );
}
