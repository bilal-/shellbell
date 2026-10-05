import { useEffect } from "react";
import { Text, View } from "react-native";
import { tokens } from "../theme/tokens";

const AUTO_HIDE_MS = 3_000;

interface ToastProps {
  text: string;
  onDone: () => void;
}

/** Auto-hides after 3 s; the caller clears `conn.toast` from `onDone` (spec 12). */
export function Toast({ text, onDone }: ToastProps) {
  useEffect(() => {
    const timer = setTimeout(onDone, AUTO_HIDE_MS);
    return () => clearTimeout(timer);
  }, [onDone]);

  return (
    <View
      style={{
        position: "absolute",
        left: 20,
        right: 20,
        bottom: 100,
        backgroundColor: tokens.surface2,
        borderColor: tokens.border,
        borderWidth: 1,
        borderRadius: tokens.radius.md,
        paddingHorizontal: 14,
        paddingVertical: 10,
      }}
    >
      <Text style={{ color: tokens.text, fontSize: 13, textAlign: "center" }}>{text}</Text>
    </View>
  );
}
