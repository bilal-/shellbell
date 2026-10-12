import { useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { useConnectionsStore } from "../store/connections";
import { useNetworkStore } from "../store/network";
import { tokens } from "../theme/tokens";
import { transportPaused, transportPresentation } from "../util/transport-state";
import { AppIcon } from "./AppIcon";

/**
 * The committed terminal route, never an inference from Wi-Fi, 5G, or socket presence.
 * `pausedOnly` keeps it out of the way while terminal traffic flows; the session header's
 * connection dot covers that state.
 */
export function TransportStatus({ fp, pausedOnly = false }: { fp: string; pausedOnly?: boolean }) {
  const connection = useConnectionsStore((s) => s.byComputer[fp]);
  const network = useNetworkStore((s) => s.snapshot);
  const [expanded, setExpanded] = useState(false);
  const state = transportPresentation(connection, network);
  const color =
    state.tone === "direct"
      ? tokens.accents.emerald
      : state.tone === "offline"
          ? tokens.textMuted
          : tokens.accents.blue;
  const details =
    pausedOnly || expanded || connection?.status !== "online";
  const canExpand = !pausedOnly && connection?.status === "online" && state.tone === "direct";
  if (pausedOnly && !transportPaused(connection)) return null;
  return (
    <View
      style={{
        paddingHorizontal: 16,
        paddingVertical: 8,
        gap: 6,
        backgroundColor: tokens.surface,
        borderBottomWidth: 1,
        borderBottomColor: tokens.border,
      }}
    >
      <Pressable
        accessibilityRole={canExpand ? "button" : "text"}
        accessibilityLabel={`Connection: ${state.label}`}
        accessibilityHint={canExpand ? "Show or hide connection details" : undefined}
        accessibilityState={canExpand ? { expanded: details } : undefined}
        disabled={!canExpand}
        onPress={() => setExpanded((value) => !value)}
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          minHeight: canExpand ? 44 : 24,
        }}
      >
        {state.busy ? (
          <ActivityIndicator size="small" color={color} />
        ) : (
          <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: color }} />
        )}
        <Text
          accessibilityLiveRegion="polite"
          style={{ color, fontSize: 13, fontWeight: "600", flex: 1 }}
        >
          {state.label}
        </Text>
        {canExpand ? (
          <AppIcon
            name={details ? "chevronUp" : "chevronDown"}
            size={16}
            color={tokens.textMuted}
          />
        ) : null}
      </Pressable>
      {details ? (
        <Text style={{ color: tokens.textMuted, fontSize: 12 }}>{state.detail}</Text>
      ) : null}
    </View>
  );
}
