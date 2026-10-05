import type { PropsWithChildren } from "react";
import { View } from "react-native";
import { useKeyboardState } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

/** Keep every route above system navigation; the keyboard owns that space while open. */
export function NavigationViewport({ children }: PropsWithChildren) {
  const insets = useSafeAreaInsets();
  const keyboardVisible = useKeyboardState((state) => state.isVisible);
  return (
    <View style={{ flex: 1, paddingBottom: keyboardVisible ? 0 : Math.max(0, insets.bottom) }}>
      {children}
    </View>
  );
}
