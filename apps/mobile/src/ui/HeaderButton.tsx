import { Pressable } from "react-native";
import { AppIcon, type AppIconName } from "./AppIcon";

export function HeaderButton({
  icon,
  label,
  onPress,
  disabled = false,
}: {
  icon: AppIconName;
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      disabled={disabled}
      accessibilityState={{ disabled }}
      style={({ pressed }) => ({
        width: 44,
        height: 44,
        alignItems: "center",
        justifyContent: "center",
        opacity: disabled ? 0.4 : pressed ? 0.55 : 1,
      })}
    >
      <AppIcon name={icon} size={22} />
    </Pressable>
  );
}
