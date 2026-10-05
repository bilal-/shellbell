import { View } from "react-native";
import type { StateTone } from "../util/session-state";
import { Pill } from "./Pill";

interface StatusOverlayProps {
  text: string;
  tone: StateTone;
}

/** Dims the screen behind it; spec 12: it dims the last screen, it never replaces it. */
export function StatusOverlay({ text, tone }: StatusOverlayProps) {
  return (
    <View
      pointerEvents="none"
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: "rgba(0,0,0,0.55)",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Pill tone={tone} text={text} />
    </View>
  );
}
