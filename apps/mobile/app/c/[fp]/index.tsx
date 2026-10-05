import { FlashList } from "@shopify/flash-list";
import { useLocalSearchParams, useRouter } from "expo-router";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import Animated, { Easing, LinearTransition } from "react-native-reanimated";
import { useComputersStore } from "../../../src/store/computers";
import { useConnectionsStore } from "../../../src/store/connections";
import { useNetworkStore } from "../../../src/store/network";
import { tokens } from "../../../src/theme/tokens";
import { EmptyState } from "../../../src/ui/EmptyState";
import { NewSessionSheet } from "../../../src/ui/NewSessionSheet";
import { Pill } from "../../../src/ui/Pill";
import { StatusOverlay } from "../../../src/ui/StatusOverlay";
import { TransportStatus } from "../../../src/ui/TransportStatus";
import { backendLabel } from "../../../src/util/backends";
import { connectionNotice } from "../../../src/util/connection-state";
import { sidToRoute } from "../../../src/util/routes";
import { statePill } from "../../../src/util/session-state";

const ERROR_COPY: Record<string, { text: string; action?: string }> = {
  unpaired: { text: "This phone was unpaired on the computer.", action: "Re-pair" },
  "re-pair": { text: "This computer's keys are out of sync.", action: "Re-pair" },
  superseded: { text: "This computer is open in another Shellbell session.", action: "Retry" },
  rejected: { text: "The relay rejected this phone's identity.", action: "Re-pair" },
  relay: { text: "The relay refused the connection.", action: "Retry" },
  "upgrade-required": { text: "This pairing requires a newer Shellbell connection protocol." },
  storage: {
    text: "Shellbell could not read this computer's saved pairing. Unlock your phone and restart the app.",
  },
};

/** spec 10.9: 150 ms ease-out layout transition when a row is added or removed. */
const ROW_TRANSITION = LinearTransition.duration(150).easing(Easing.out(Easing.ease));

export default function Sessions() {
  const network = useNetworkStore((s) => s.snapshot);
  const { fp } = useLocalSearchParams<{ fp: string }>();
  const router = useRouter();
  const [showNewSession, setShowNewSession] = useState(false);
  const computer = useComputersStore((s) => s.computers.find((c) => c.fp === fp));
  const conn = useConnectionsStore((s) => s.byComputer[fp ?? ""]);
  const accentKey = (computer?.accent ?? "emerald") as keyof typeof tokens.accents;
  const accent = tokens.accents[accentKey] ?? tokens.accents.emerald;
  const withStatus = (content: ReactNode) => (
    <View style={{ flex: 1, backgroundColor: tokens.bg }}>
      <TransportStatus fp={fp ?? ""} />
      {content}
      <NewSessionSheet
        fp={fp ?? ""}
        visible={showNewSession}
        onClose={() => setShowNewSession(false)}
        onCreated={(sessionId) => router.push(`/c/${fp}/s/${sidToRoute(sessionId)}`)}
      />
    </View>
  );

  const rows = useMemo(() => {
    const list = conn?.sessions ?? [];
    type Row =
      | { kind: "header"; key: string; text: string }
      | { kind: "session"; key: string; s: (typeof list)[number] };
    const out: Row[] = [];
    let lastGroup = "";
    for (const s of list) {
      const group = `${s.backend}:${s.windowId}`;
      if (group !== lastGroup) {
        out.push({
          kind: "header",
          key: `h:${group}`,
          text: `${backendLabel(s.backend)} · window ${s.windowNumber}`,
        });
        lastGroup = group;
      }
      out.push({ kind: "session", key: s.id, s });
    }
    return out;
  }, [conn?.sessions]);

  const newSession = () => setShowNewSession(true);

  const errored = conn?.status === "error" && conn.error;
  if (errored) {
    const copy = ERROR_COPY[conn.error ?? "relay"] ?? ERROR_COPY.relay;
    return withStatus(
      <EmptyState
        text={copy?.text ?? "The connection failed."}
        action={
          copy?.action ? { label: copy.action, onPress: () => router.push("/pair") } : undefined
        }
      />,
    );
  }
  if (rows.length === 0 && conn?.status === "online") {
    return withStatus(
      <EmptyState
        text="No terminal sessions yet. Open a terminal app on your computer or create a session."
        action={{ label: "New session", onPress: newSession }}
      />,
    );
  }
  if (rows.length === 0)
    return withStatus(<EmptyState text={connectionNotice(conn, network, computer?.name)} />);

  const dimmed = conn?.status !== "online" || conn.transport?.ready === false;
  const overlay = connectionNotice(conn, network, computer?.name);

  return withStatus(
    <View style={{ flex: 1, backgroundColor: tokens.bg }}>
      <FlashList
        data={rows}
        keyExtractor={(r) => r.key}
        getItemType={(r) => r.kind}
        contentContainerStyle={{ padding: 12 }}
        renderItem={({ item }) => {
          if (item.kind === "header") {
            return (
              <Animated.View layout={ROW_TRANSITION}>
                <Text
                  style={{
                    color: tokens.textMuted,
                    fontSize: 12,
                    letterSpacing: 1,
                    marginTop: 12,
                    marginBottom: 6,
                  }}
                >
                  {item.text.toUpperCase()}
                </Text>
              </Animated.View>
            );
          }
          const pill = statePill(item.s.state);
          return (
            <Animated.View layout={ROW_TRANSITION}>
              <Pressable
                onPress={() => router.push(`/c/${fp}/s/${sidToRoute(item.s.id)}`)}
                style={{
                  paddingVertical: 10,
                  borderBottomColor: tokens.border,
                  borderBottomWidth: 1,
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 10,
                }}
              >
                <View
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: 4,
                    backgroundColor: item.s.isFocusedOnMac ? accent : tokens.textFaint,
                  }}
                />
                <View style={{ flex: 1 }}>
                  <Text style={{ color: tokens.text, fontSize: 15 }} numberOfLines={1}>
                    {item.s.title}
                  </Text>
                  {item.s.cwd ? (
                    <Text style={{ color: tokens.textMuted, fontSize: 12 }} numberOfLines={1}>
                      {item.s.cwd}
                    </Text>
                  ) : null}
                </View>
                <Pill tone="muted" text={backendLabel(item.s.backend)} />
                {pill ? <Pill tone={pill.tone} text={pill.label} /> : null}
                {(conn?.unread[item.s.id] ?? 0) > 0 ? (
                  <View
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: 4,
                      backgroundColor: tokens.accents.rose,
                    }}
                  />
                ) : null}
              </Pressable>
            </Animated.View>
          );
        }}
      />
      {dimmed ? <StatusOverlay text={overlay} tone="muted" /> : null}
      <Pressable
        accessibilityLabel="New session"
        onPress={newSession}
        style={{
          position: "absolute",
          right: 20,
          bottom: 32,
          width: 56,
          height: 56,
          borderRadius: 28,
          // spec 10.9: the computer's accent tints exactly card stripe, session dot, cursor, send
          // button and connection indicator — this "+" is a fixed brand action, like the pairing
          // FAB on the computers list, not a sixth accented surface.
          backgroundColor: tokens.accents.emerald,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Text style={{ color: tokens.bg, fontSize: 28, lineHeight: 30 }}>+</Text>
      </Pressable>
    </View>,
  );
}
