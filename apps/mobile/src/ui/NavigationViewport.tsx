import type { PropsWithChildren } from "react";
import { View } from "react-native";
import { useKeyboardState } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

/**
 * Keep every route above system navigation; the keyboard owns that space only while it is on
 * screen. Android can report the keyboard as still visible after it has gone, so a zero height
 * keeps the inset rather than dropping every route under the navigation bar.
 */
export function NavigationViewport({ children }: PropsWithChildren) {
  const insets = useSafeAreaInsets();
  const keyboardOpen = useKeyboardState((state) => state.isVisible && state.height > 0);
  return (
    <View style={{ flex: 1, paddingBottom: keyboardOpen ? 0 : Math.max(0, insets.bottom) }}>
      {children}
    </View>
  );
}
