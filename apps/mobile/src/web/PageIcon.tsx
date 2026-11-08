import { Image, Text, View } from "react-native";
import { pageTileColor } from "./page-catalog";
export function PageIcon({
  id,
  name,
  uri,
  size = 36,
}: {
  id: string;
  name: string;
  uri?: string;
  size?: number;
}) {
  return uri ? (
    <Image
      source={{ uri }}
      accessible={false}
      style={{ width: size, height: size, borderRadius: Math.round(size / 5) }}
    />
  ) : (
    <View
      accessible={false}
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size / 5),
        backgroundColor: pageTileColor(id),
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Text style={{ color: "#000000", fontSize: Math.round(size * 0.52), fontWeight: "700" }}>
        {Array.from(name.trim())[0]?.toLocaleUpperCase() ?? "?"}
      </Text>
    </View>
  );
}
