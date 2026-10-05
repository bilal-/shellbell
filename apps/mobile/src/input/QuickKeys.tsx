import type { HostPlatform, NamedKey } from "@shellbell/protocol";
import { Pressable, ScrollView, Text } from "react-native";
import { tokens } from "../theme/tokens";
import { keyPresentation } from "./keyPresentation";

export function QuickKeys({
  onKey,
  onPaste,
  hostPlatform,
  onGuide,
  disabled = false,
}: {
  onKey: (key: NamedKey) => void;
  onPaste: () => void;
  hostPlatform?: HostPlatform;
  onGuide?: () => void;
  disabled?: boolean;
}) {
  return (
    <ScrollView
      horizontal
      keyboardShouldPersistTaps="always"
      keyboardDismissMode="none"
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ gap: 8, paddingVertical: 2 }}
    >
      {onGuide ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Key guide"
          accessibilityHint="Explains terminal keys without sending input"
          onPress={onGuide}
          style={{ height: 32, paddingHorizontal: 10, justifyContent: "center" }}
        >
          <Text style={{ color: tokens.textMuted, fontSize: 13 }}>Key guide</Text>
        </Pressable>
      ) : null}
      {keyPresentation(hostPlatform).keys.map((k) => (
        <Pressable
          key={k.key}
          accessibilityRole="button"
          accessibilityLabel={k.accessibilityLabel}
          accessibilityHint="Sends this key to the terminal"
          disabled={disabled}
          accessibilityState={{ disabled }}
          onPress={() => onKey(k.key)}
          style={{
            minWidth: 36,
            height: 32,
            paddingHorizontal: 10,
            borderRadius: tokens.radius.sm,
            borderWidth: 1,
            borderColor: tokens.border,
            backgroundColor: tokens.surface2,
            alignItems: "center",
            justifyContent: "center",
            opacity: disabled ? 0.4 : 1,
          }}
        >
          <Text style={{ color: tokens.text, fontSize: 13 }}>{k.label}</Text>
        </Pressable>
      ))}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Paste to terminal"
        accessibilityHint="Sends clipboard text to the terminal"
        disabled={disabled}
        accessibilityState={{ disabled }}
        onPress={onPaste}
        style={{
          minWidth: 36,
          height: 32,
          paddingHorizontal: 10,
          borderRadius: tokens.radius.sm,
          borderWidth: 1,
          borderColor: tokens.border,
          backgroundColor: tokens.surface2,
          alignItems: "center",
          justifyContent: "center",
          opacity: disabled ? 0.4 : 1,
        }}
      >
        <Text style={{ color: tokens.text, fontSize: 13 }}>Paste</Text>
      </Pressable>
    </ScrollView>
  );
}
