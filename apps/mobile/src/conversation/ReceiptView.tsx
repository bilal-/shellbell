import { Pressable, Text } from "react-native";
import { tokens } from "../theme/tokens";
import { Fade } from "./motion";
import type { SendReceipt } from "./receipt";

const COLOR: Record<SendReceipt["state"], string> = {
  sending: tokens.textMuted,
  sent: tokens.textMuted,
  refused: "#FBBF24",
  unknown: "#FBBF24",
};

/** The latest send's outcome under the conversation. A tap dismisses it. */
export function ReceiptView({
  receipt,
  onDismiss,
}: {
  receipt: SendReceipt;
  onDismiss: () => void;
}) {
  return (
    <Fade style={{ alignSelf: "flex-end", maxWidth: "100%" }}>
      <Pressable
        testID="send-receipt"
        accessibilityRole="button"
        accessibilityLabel={receipt.state === "sent" ? `${receipt.text}, confirmed` : receipt.text}
        accessibilityHint="Dismisses this message"
        accessibilityLiveRegion="polite"
        onPress={onDismiss}
        style={{ minHeight: 32, paddingHorizontal: 14, justifyContent: "center" }}
      >
        <Text style={{ color: COLOR[receipt.state], fontSize: 12, textAlign: "right" }}>
          {receipt.text}
          {receipt.state === "sent" ? (
            <Text style={{ color: "#4ADE80", fontWeight: "700" }}> ✓</Text>
          ) : null}
        </Text>
      </Pressable>
    </Fade>
  );
}
