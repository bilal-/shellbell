import { Text, View } from "react-native";
import { useNetworkStore } from "../store/network";
import { tokens } from "../theme/tokens";

export function NetworkBanner() {
  const offline = useNetworkStore((state) => state.snapshot.internet === "offline");
  if (!offline) return null;
  return (
    <View style={{ padding: 10, backgroundColor: tokens.surface2 }}>
      <Text
        accessibilityRole="alert"
        accessibilityLiveRegion="polite"
        style={{ color: tokens.accents.amber, textAlign: "center" }}
      >
        No internet connection
      </Text>
    </View>
  );
}
