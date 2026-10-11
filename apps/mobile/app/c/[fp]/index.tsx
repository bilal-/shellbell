import { FlashList } from "@shopify/flash-list";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import type { ReactNode } from "react";
import { useCallback, useMemo, useState } from "react";
import { Alert, Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { connectionManager } from "../../../src/net/manager";
import { unpairComputer } from "../../../src/net/unpair-computer";
import { useComputersStore } from "../../../src/store/computers";
import { useConnectionsStore } from "../../../src/store/connections";
import { useNetworkStore } from "../../../src/store/network";
import { tokens } from "../../../src/theme/tokens";
import { AppIcon } from "../../../src/ui/AppIcon";
import { EmptyState } from "../../../src/ui/EmptyState";
import { NewSessionSheet } from "../../../src/ui/NewSessionSheet";
import { SessionRow } from "../../../src/ui/SessionRow";
import { StatusOverlay } from "../../../src/ui/StatusOverlay";
import { TransportStatus } from "../../../src/ui/TransportStatus";
import { backendLabel } from "../../../src/util/backends";
import { connectionNotice } from "../../../src/util/connection-state";
import { sidToRoute } from "../../../src/util/routes";
import { groupLabel, sessionTitle } from "../../../src/util/session-label";

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

export default function Sessions() {
  const insets = useSafeAreaInsets();
  const network = useNetworkStore((s) => s.snapshot);
  const { fp } = useLocalSearchParams<{ fp: string }>();
  const router = useRouter();
  const [showNewSession, setShowNewSession] = useState(false);
  // A notification tap can open a session over this list; the sheet must not wait behind it.
  useFocusEffect(useCallback(() => () => setShowNewSession(false), []));
  const computer = useComputersStore((s) => s.computers.find((c) => c.fp === fp));
  const conn = useConnectionsStore((s) => s.byComputer[fp ?? ""]);
  const accentKey = (computer?.accent ?? "emerald") as keyof typeof tokens.accents;
  const accent = tokens.accents[accentKey] ?? tokens.accents.emerald;
  const withStatus = (content: ReactNode) => (
    <View
      style={{
        flex: 1,
        backgroundColor: tokens.bg,
        paddingLeft: insets.left,
        paddingRight: insets.right,
      }}
    >
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
      | { kind: "header"; key: string; backend: string; name?: string }
      | { kind: "session"; key: string; s: (typeof list)[number] };
    const out: Row[] = [];
    const groupOf = (s: (typeof list)[number]) => `${s.backend}:${s.windowId}`;
    const sizes = new Map<string, number>();
    for (const s of list) sizes.set(groupOf(s), (sizes.get(groupOf(s)) ?? 0) + 1);
    let lastGroup = "";
    for (const s of list) {
      const group = groupOf(s);
      if (group !== lastGroup) {
        const label = groupLabel(backendLabel(s.backend, conn?.hello?.backendCatalog), s);
        // "HERDR · shellbell" above a lone "shellbell" row says nothing the row does not.
        if (sizes.get(group) !== 1 || label.name !== sessionTitle(s))
          out.push({ kind: "header", key: `h:${group}`, ...label });
        lastGroup = group;
      }
      out.push({ kind: "session", key: s.id, s });
    }
    return out;
  }, [conn?.sessions, conn?.hello?.backendCatalog]);

  const mixedBackends = new Set((conn?.sessions ?? []).map((s) => s.backend)).size > 1;

  const newSession = () => setShowNewSession(true);

  // Pairing refuses a computer that still has a record here, so finish unpairing first.
  const rePair = () => {
    if (!computer) {
      router.push("/pair");
      return;
    }
    Alert.alert(
      "Re-pair this computer?",
      "Shellbell will unpair it on this phone, then you can scan its QR code again.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Re-pair",
          style: "destructive",
          onPress: async () => {
            try {
              await unpairComputer(computer);
              router.replace("/pair");
            } catch {
              Alert.alert(
                "Could not finish unpairing",
                "Unpair this computer in its settings, then scan its QR code again.",
              );
            }
          },
        },
      ],
    );
  };

  const errored = conn?.status === "error" && conn.error;
  if (errored) {
    const copy = ERROR_COPY[conn.error ?? "relay"] ?? ERROR_COPY.relay;
    return withStatus(
      <EmptyState
        text={copy?.text ?? "The connection failed."}
        action={
          copy?.action
            ? {
                label: copy.action,
                onPress: () =>
                  copy.action === "Retry" ? connectionManager.get(fp ?? "")?.connect() : rePair(),
              }
            : undefined
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
        contentContainerStyle={{ padding: 12, paddingBottom: 112 }}
        renderItem={({ item }) => {
          if (item.kind === "header") {
            return (
              <View>
                <Text
                  numberOfLines={1}
                  style={{
                    color: tokens.textMuted,
                    fontSize: 12,
                    letterSpacing: 1,
                    marginTop: 12,
                    marginBottom: 6,
                  }}
                >
                  {item.name ? (
                    <>
                      {`${item.backend} · `}
                      {/* A workspace keeps its own spelling (`webBooks`); only the backend is capitals. */}
                      <Text style={{ color: tokens.text, letterSpacing: 0.2 }}>{item.name}</Text>
                    </>
                  ) : (
                    item.backend
                  )}
                </Text>
              </View>
            );
          }
          return (
            <View>
              <SessionRow
                session={item.s}
                backend={backendLabel(item.s.backend, conn?.hello?.backendCatalog)}
                showBackend={mixedBackends}
                accent={accent}
                unread={(conn?.unread[item.s.id] ?? 0) > 0}
                onPress={() => router.push(`/c/${fp}/s/${sidToRoute(item.s.id)}`)}
              />
            </View>
          );
        }}
      />
      {dimmed ? <StatusOverlay text={overlay} tone="muted" /> : null}
      <Pressable
        accessibilityRole="button"
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
        <AppIcon name="plus" color={tokens.bg} size={26} />
      </Pressable>
    </View>,
  );
}
