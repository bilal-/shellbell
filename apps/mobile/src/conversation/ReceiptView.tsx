import { Pressable, Text } from "react-native";
import { tokens } from "../theme/tokens";
import { CheckIn, Fade } from "./motion";
import type { SendReceipt } from "./receipt";

const COLOR: Record<SendReceipt["state"], string> = {
  sending: tokens.textMuted,
  sent: tokens.textMuted,
  refused: tokens.terminal16[3],
  unknown: tokens.terminal16[3],
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
        style={{
          minHeight: 32,
          paddingHorizontal: 14,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "flex-end",
          gap: 4,
        }}
      >
        <Text
          style={{ flexShrink: 1, color: COLOR[receipt.state], fontSize: 12, textAlign: "right" }}
        >
          {receipt.text}
        </Text>
        {receipt.state === "sent" ? (
          <CheckIn>
            <Text style={{ color: tokens.terminal16[2], fontSize: 12, fontWeight: "700" }}>✓</Text>
          </CheckIn>
        ) : null}
      </Pressable>
    </Fade>
  );
}
