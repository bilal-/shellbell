import { Link } from "expo-router";
import { Pressable, Text } from "react-native";
import { tokens } from "../theme/tokens";

export function SettingsButton() {
  return (
    <Link href="/settings" asChild>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Settings"
        style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}
      >
        <Text accessible={false} style={{ color: tokens.text, fontSize: 25 }}>
          ⚙︎
        </Text>
      </Pressable>
    </Link>
  );
}
