import type { PropsWithChildren } from "react";
import { View } from "react-native";
import { tokens } from "../theme/tokens";

interface CardProps {
  accent: string;
}

/** A list-row surface with a left accent stripe (spec 10.9). */
export function Card({ accent, children }: PropsWithChildren<CardProps>) {
  return (
    <View
      style={{
        flexDirection: "row",
        backgroundColor: tokens.surface,
        borderColor: tokens.border,
        borderWidth: 1,
        borderRadius: tokens.radius.lg,
        marginBottom: 10,
        overflow: "hidden",
      }}
    >
      <View style={{ width: 4, backgroundColor: accent }} />
      <View style={{ flex: 1, padding: 12 }}>{children}</View>
    </View>
  );
}
