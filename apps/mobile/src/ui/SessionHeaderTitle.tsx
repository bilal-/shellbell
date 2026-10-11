import { useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { connectionManager } from "../net/manager";
import { useCloseWhenHidden } from "../security/screen-hidden";
import { useComputersStore } from "../store/computers";
import { useConnectionsStore } from "../store/connections";
import { useNetworkStore } from "../store/network";
import { tokens } from "../theme/tokens";
import {
  type TransportIndicator,
  transportIndicator,
  transportPresentation,
} from "../util/transport-state";
import { Sheet } from "./Sheet";

const DOT: Record<TransportIndicator["tone"], string> = {
  ok: tokens.accents.emerald,
  degraded: tokens.accents.amber,
  offline: tokens.textMuted,
  error: tokens.accents.rose,
};

/**
 * The session screen's title: the project, a short status line, and a dot for the committed
 * terminal route. The route only gets a word while it is not direct. Tapping opens the details
 * that the old full-width connection strip showed, including the temporary relay choice.
 */
export function SessionHeaderTitle({
  fp,
  title,
  subtitle,
}: {
  fp: string;
  title: string;
  subtitle?: string;
}) {
  const connection = useConnectionsStore((s) => s.byComputer[fp]);
  const network = useNetworkStore((s) => s.snapshot);
  const [open, setOpen] = useState(false);
  // Lives in the session header: close with its screen so it cannot re-present over another.
  useFocusEffect(useCallback(() => () => setOpen(false), []));
  const indicator = transportIndicator(connection, network);
  const presentation = transportPresentation(connection, network);
  const color = DOT[indicator.tone];
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={[title, subtitle, `connection: ${presentation.label}`]
          .filter(Boolean)
          .join(", ")}
        accessibilityHint="Shows connection details"
        onPress={() => setOpen(true)}
        hitSlop={6}
        style={({ pressed }) => ({
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          minHeight: 44,
          flexShrink: 1,
          opacity: pressed ? 0.6 : 1,
        })}
      >
        <View
          testID="connection-dot"
          style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }}
        />
        <View style={{ flexShrink: 1 }}>
          <Text
            numberOfLines={1}
            style={{ color: tokens.text, fontSize: 17, fontWeight: "600", lineHeight: 22 }}
          >
            {title}
          </Text>
          {subtitle || indicator.word ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              {subtitle ? (
                <Text
                  numberOfLines={1}
                  style={{ color: tokens.textMuted, fontSize: 12, lineHeight: 16, flexShrink: 1 }}
                >
                  {subtitle}
                </Text>
              ) : null}
              {indicator.word ? (
                <Text
                  numberOfLines={1}
                  style={{ color, fontSize: 12, lineHeight: 16, fontWeight: "600" }}
                >
                  {indicator.word}
                </Text>
              ) : null}
            </View>
          ) : null}
        </View>
      </Pressable>
      <ConnectionSheet fp={fp} visible={open} onClose={() => setOpen(false)} />
    </>
  );
}

/** Transport details and the one transport choice a person can make. */
export function ConnectionSheet({
  fp,
  visible,
  onClose,
}: {
  fp: string;
  visible: boolean;
  onClose: () => void;
}) {
  const hidden = useCloseWhenHidden(visible, onClose);
  const connection = useConnectionsStore((s) => s.byComputer[fp]);
  const network = useNetworkStore((s) => s.snapshot);
  const computerName = useComputersStore((s) => s.computers.find((c) => c.fp === fp)?.name);
  const state = transportPresentation(connection, network);
  const color = DOT[transportIndicator(connection, network).tone];
  return (
    <Sheet
      visible={visible && !hidden}
      onClose={onClose}
      dismissLabel="Dismiss connection details"
      accessibilityLabel="Connection details"
    >
      <View style={{ gap: 2 }}>
        <Text
          accessibilityRole="header"
          style={{ color: tokens.text, fontSize: 20, fontWeight: "600" }}
        >
          Connection
        </Text>
        {computerName ? (
          <Text numberOfLines={1} style={{ color: tokens.textMuted, fontSize: 13 }}>
            {computerName}
          </Text>
        ) : null}
      </View>
      <View
        style={{
          gap: 6,
          padding: 14,
          borderRadius: tokens.radius.md,
          borderWidth: 1,
          borderColor: tokens.border,
          backgroundColor: tokens.surface,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          {state.busy ? (
            <ActivityIndicator size="small" color={color} />
          ) : (
            <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }} />
          )}
          <Text
            accessibilityLiveRegion="polite"
            style={{ color, fontSize: 16, fontWeight: "600", flex: 1 }}
          >
            {state.label}
          </Text>
        </View>
        <Text style={{ color: tokens.textMuted, fontSize: 13, lineHeight: 19 }}>
          {state.detail}
        </Text>
      </View>
      {state.allowRelay ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Use encrypted relay temporarily"
          accessibilityHint="Sends terminal traffic through the encrypted relay until a direct connection returns"
          onPress={() => connectionManager.get(fp)?.allowRelayOnce()}
          style={({ pressed }) => ({
            minHeight: 48,
            justifyContent: "center",
            alignItems: "center",
            borderRadius: tokens.radius.md,
            borderWidth: 1,
            borderColor: tokens.accents.amber,
            opacity: pressed ? 0.6 : 1,
          })}
        >
          <Text style={{ color: tokens.accents.amber, fontSize: 15, fontWeight: "600" }}>
            Use relay temporarily
          </Text>
        </Pressable>
      ) : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Close connection details"
        onPress={onClose}
        style={{ minHeight: 48, alignItems: "center", justifyContent: "center" }}
      >
        <Text style={{ color: tokens.text, fontSize: 15 }}>Done</Text>
      </Pressable>
    </Sheet>
  );
}
