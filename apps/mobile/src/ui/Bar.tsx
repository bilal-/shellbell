import { GlassView, isGlassEffectAPIAvailable } from "expo-glass-effect";
import type { PropsWithChildren } from "react";
import { Platform, View, type ViewStyle } from "react-native";
import { tokens } from "../theme/tokens";

const glass = Platform.OS === "ios" && isGlassEffectAPIAvailable();

/**
 * Review I4: this is the bottom-most bar on the session screen (it hosts the input field), so it
 * must clear the iPhone home indicator / Android gesture area itself -- nothing renders below it.
 */
export function Bar({
  children,
  style,
  verticalPadding = 8,
}: PropsWithChildren<{
  style?: ViewStyle;
  verticalPadding?: number;
}>) {
  const paddingBottom = verticalPadding;
  if (glass) {
    return (
      <GlassView
        glassEffectStyle="regular"
        style={[{ paddingHorizontal: 12, paddingTop: verticalPadding, paddingBottom }, style]}
      >
        {children}
      </GlassView>
    );
  }
  return (
    <View
      style={[
        {
          // tokens.surface (#0B0B0D) at 92% opacity: the non-glass fallback still wants a
          // translucent bar (so content scrolling underneath is faintly visible, echoing the
          // GlassView look above), which an opaque token can't express.
          backgroundColor: "rgba(11,11,13,0.92)",
          borderColor: tokens.border,
          borderWidth: 1,
          paddingHorizontal: 12,
          paddingTop: verticalPadding,
          paddingBottom,
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}
