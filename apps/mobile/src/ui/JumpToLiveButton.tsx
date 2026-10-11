import { Pressable } from "react-native";
import { tokens } from "../theme/tokens";
import { AppIcon } from "./AppIcon";

/**
 * Shown while the person reads history. Docked in the terminal pane's bottom-right corner, just
 * above the input area, so it covers the end of a line rather than the middle of the output.
 */
export function JumpToLiveButton({ onPress }: { onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Jump to live"
      onPress={onPress}
      hitSlop={6}
      style={{
        position: "absolute",
        right: 12,
        bottom: 12,
        width: 44,
        height: 44,
        borderRadius: 22,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: tokens.surface2,
        borderWidth: 1,
        borderColor: tokens.border,
        shadowColor: "#000",
        shadowOpacity: 0.4,
        shadowRadius: 6,
        shadowOffset: { width: 0, height: 2 },
        elevation: 4,
      }}
    >
      <AppIcon name="down" size={20} />
    </Pressable>
  );
}
