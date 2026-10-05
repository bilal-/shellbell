import * as Clipboard from "expo-clipboard";
import { useState } from "react";
import { Modal, Pressable, ScrollView, Text, View } from "react-native";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";
import { FONT, tokens } from "../theme/tokens";
import type { SelectionSnapshot } from "./selection-snapshot";

export function SelectionSheet(props: { snapshot: SelectionSnapshot; onClose: () => void }) {
  return (
    <Modal
      visible
      animationType="slide"
      onRequestClose={props.onClose}
      supportedOrientations={["portrait", "landscape-left", "landscape-right"]}
    >
      <SafeAreaProvider>
        <SelectionContent {...props} />
      </SafeAreaProvider>
    </Modal>
  );
}

function SelectionContent({
  snapshot,
  onClose,
}: {
  snapshot: SelectionSnapshot;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [status, setStatus] = useState("");
  const button = (label: string, press: () => void) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={press}
      style={({ pressed }) => ({
        minHeight: 48,
        justifyContent: "center",
        paddingHorizontal: 12,
        borderRadius: tokens.radius.sm,
        backgroundColor: pressed ? tokens.surface2 : "transparent",
      })}
    >
      <Text style={{ color: tokens.text }}>{label}</Text>
    </Pressable>
  );
  return (
    <View
      style={{
        flex: 1,
        backgroundColor: tokens.bg,
        paddingTop: insets.top,
        paddingBottom: insets.bottom,
        paddingLeft: insets.left,
        paddingRight: insets.right,
      }}
    >
      <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between" }}>
        {button("Close selection", onClose)}
        {button("Copy snapshot", () => {
          void Clipboard.setStringAsync(snapshot.text).then(
            (copied) => setStatus(copied ? "Copied" : "Could not copy. Try again."),
            () => setStatus("Could not copy. Try again."),
          );
        })}
      </View>
      <Text style={{ color: tokens.text, fontSize: 20, paddingHorizontal: 16 }}>Select text</Text>
      <Text style={{ color: tokens.textMuted, padding: 16 }}>
        Hold text to select and copy. This snapshot includes visible terminal rows or Reading
        paragraphs, not the full session.
        {snapshot.truncated
          ? " Limited to 128 rows or 32 KiB; remaining text is not included."
          : ""}
      </Text>
      {status ? (
        <Text
          accessibilityLiveRegion="polite"
          style={{ color: tokens.text, paddingHorizontal: 16 }}
        >
          {status}
        </Text>
      ) : null}
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16 }}>
        <Text selectable style={{ color: tokens.text, fontFamily: FONT.regular, fontSize: 15 }}>
          {snapshot.text}
        </Text>
      </ScrollView>
    </View>
  );
}
