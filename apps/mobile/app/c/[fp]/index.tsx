import { CONVERSATION_FEATURE } from "@shellbell/protocol";
import { FlashList } from "@shopify/flash-list";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { prefersConversation } from "../../../src/agents/registry";
import { connectionManager } from "../../../src/net/manager";
import { unpairComputer } from "../../../src/net/unpair-computer";
import { type SessionListView, useComputersStore, useUiStore } from "../../../src/store/computers";
import { useConnectionsStore } from "../../../src/store/connections";
import { useNetworkStore } from "../../../src/store/network";
import { tokens } from "../../../src/theme/tokens";
import { AppIcon } from "../../../src/ui/AppIcon";
import { EmptyState } from "../../../src/ui/EmptyState";
import { NewSessionSheet } from "../../../src/ui/NewSessionSheet";
import { SessionRow } from "../../../src/ui/SessionRow";
import { StatusOverlay } from "../../../src/ui/StatusOverlay";
import { useSteadyRows } from "../../../src/ui/steady-rows";
import { TerminalSetupNotice } from "../../../src/ui/TerminalSetupNotice";
import { TransportStatus } from "../../../src/ui/TransportStatus";
import { agentRows, agentSessions, settleOrder, waitingCount } from "../../../src/util/agents-view";
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

/** The floating New session button; the list scrolls its last row clear of it. */
const FAB_SIZE = 56;
const FAB_BOTTOM = 32;
const FAB_CLEARANCE = 16;
/** The Agents list re-sorts at most this often, so rows don't move under a finger. */
const RESORT_MS = 3000;

/** The current time, advancing each minute while `running`. */
function useMinuteClock(running: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, [running]);
  return now;
}

/** The Agents order, re-sorted at most every `RESORT_MS` (see `settleOrder`). */
function useSettledOrder(ids: readonly string[]): string[] {
  const shown = useRef<string[]>([...ids]);
  const last = useRef(0);
  const [, resorted] = useState(0);
  const key = ids.join("\n");
  useEffect(() => {
    const due = last.current + RESORT_MS - Date.now();
    const resort = () => {
      last.current = Date.now();
      shown.current = key ? key.split("\n") : [];
      resorted((n) => n + 1);
    };
    if (due <= 0) {
      resort();
      return;
    }
    const timer = setTimeout(resort, due);
    return () => clearTimeout(timer);
  }, [key]);
  // Joins and leaves apply now and are remembered, so a new row stays where it first appeared.
  shown.current = settleOrder(shown.current, ids);
  return shown.current;
}

/** Agents or Terminals, with a count of agents waiting for you on Agents. */
function ViewSwitch({
  view,
  waiting,
  onChange,
}: {
  view: SessionListView;
  waiting: number;
  onChange: (view: SessionListView) => void;
}) {
  const tab = (name: SessionListView, label: string) => (
    <Pressable
      accessibilityRole="tab"
      accessibilityState={{ selected: view === name }}
      accessibilityLabel={
        name === "agents" && waiting ? `${label}, ${waiting} waiting for you` : label
      }
      onPress={() => onChange(name)}
      style={{
        flex: 1,
        minHeight: 36,
        borderRadius: 8,
        alignItems: "center",
        justifyContent: "center",
        flexDirection: "row",
        gap: 6,
        backgroundColor: view === name ? tokens.surface2 : "transparent",
      }}
    >
      <Text style={{ color: view === name ? tokens.text : tokens.textMuted, fontSize: 14 }}>
        {label}
      </Text>
      {name === "agents" && waiting ? (
        <View
          style={{
            minWidth: 18,
            height: 18,
            borderRadius: 9,
            paddingHorizontal: 5,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: tokens.accents.amber,
          }}
        >
          <Text style={{ color: tokens.bg, fontSize: 11, fontWeight: "600" }}>{waiting}</Text>
        </View>
      ) : null}
    </Pressable>
  );
  return (
    <View
      accessibilityRole="tablist"
      style={{
        flexDirection: "row",
        gap: 4,
        padding: 3,
        marginHorizontal: 12,
        marginTop: 8,
        borderRadius: 10,
        backgroundColor: tokens.surface,
      }}
    >
      {tab("agents", "Agents")}
      {tab("terminals", "Terminals")}
    </View>
  );
}

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
      <TerminalSetupNotice setup={conn?.hello?.terminalSetup} />
      {showSwitch ? <ViewSwitch view={view} waiting={waiting} onChange={setView} /> : null}
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
      | { kind: "header"; key: string; backend: string; name?: string; shownIn?: string }
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
        // "HERDR · shellbell" above a lone "shellbell" row says nothing the row does not, unless
        // it also says which app shows it.
        if (sizes.get(group) !== 1 || label.name !== sessionTitle(s) || label.shownIn)
          out.push({ kind: "header", key: `h:${group}`, ...label });
        lastGroup = group;
      }
      out.push({ kind: "session", key: s.id, s });
    }
    return out;
  }, [conn?.sessions, conn?.hello?.backendCatalog]);

  const mixedBackends = new Set((conn?.sessions ?? []).map((s) => s.backend)).size > 1;

  // Newer computers say which agents report their own state; older ones keep today's words.
  const reportsStates = conn?.sessionsComplete != null;
  const agents = useMemo(
    () => agentSessions(conn?.sessions ?? [], reportsStates),
    [conn?.sessions, reportsStates],
  );
  const waiting = waitingCount(conn?.sessions ?? [], reportsStates);
  const chosen = useUiStore((s) => s.sessionViews[fp ?? ""]);
  const view: SessionListView = chosen ?? (agents.length ? "agents" : "terminals");
  const setView = (next: SessionListView) => useUiStore.getState().setSessionView(fp ?? "", next);
  const agentOrder = useSettledOrder(agents.map((s) => s.id));
  const orderKey = agentOrder.join("\n");
  const conversations =
    conn?.hello?.conversationEnabled === true &&
    conn.hello.features?.includes(CONVERSATION_FEATURE) === true;
  // Ages and dimming move with the clock, not only when the computer sends something.
  const now = useMinuteClock(view === "agents");
  const catalog = conn?.hello?.backendCatalog;
  const agentList = useMemo(() => {
    const byId = new Map(agents.map((s) => [s.id, s]));
    // The settled order arrives as a fresh array each render; its joined ids are the key.
    return agentRows(
      (orderKey ? orderKey.split("\n") : []).flatMap((id) => byId.get(id) ?? []),
      {
        reportsStates,
        now,
        placeOf: (s) => groupLabel(backendLabel(s.backend, catalog), s).name,
        conversation: (s) => conversations && prefersConversation(s.agent?.kind),
      },
    );
  }, [agents, orderKey, reportsStates, now, catalog, conversations]);
  // Rows hold still under a finger, and a tap aimed before they moved opens nothing.
  const steadyAgents = useSteadyRows(agentList, (row) => row.session.id);
  const steadyRows = useSteadyRows(rows, (row) => row.key);
  const showSwitch = !(conn?.status === "error" && conn.error) && rows.length > 0;

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

  if (view === "agents") {
    if (!agentList.length)
      return withStatus(
        conn?.sessionsComplete === false ? (
          <EmptyState text="Can’t see all sessions right now. Your computer has more than it can list at once." />
        ) : (
          <EmptyState
            text="No agents running. Start one in a terminal, for example by typing claude, and it appears here."
            action={{
              label: "Open a terminal",
              onPress: () => {
                setView("terminals");
                newSession();
              },
            }}
          />
        ),
      );
    return withStatus(
      <View style={{ flex: 1, backgroundColor: tokens.bg }} {...steadyAgents.touch}>
        <FlashList
          data={steadyAgents.rows}
          keyExtractor={(row) => row.session.id}
          contentContainerStyle={{ padding: 12, paddingBottom: 24 + insets.bottom }}
          renderItem={({ item: row }) => (
            <SessionRow
              session={row.session}
              backend={backendLabel(row.session.backend, catalog)}
              showBackend={false}
              accent={accent}
              unread={(conn?.unread[row.session.id] ?? 0) > 0}
              status={{ label: row.label, tone: row.tone }}
              place={row.place}
              dim={row.dim}
              hint={row.conversation ? "Open conversation" : "Open terminal"}
              onPress={() => {
                if (steadyAgents.landed()) router.push(`/c/${fp}/s/${sidToRoute(row.session.id)}`);
              }}
            />
          )}
        />
        {dimmed ? <StatusOverlay tone="muted" /> : null}
      </View>,
    );
  }

  return withStatus(
    <View style={{ flex: 1, backgroundColor: tokens.bg }} {...steadyRows.touch}>
      <FlashList
        data={steadyRows.rows}
        keyExtractor={(r) => r.key}
        getItemType={(r) => r.kind}
        contentContainerStyle={{
          padding: 12,
          paddingBottom: FAB_BOTTOM + FAB_SIZE + FAB_CLEARANCE + insets.bottom,
        }}
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
                      {item.shownIn ? ` · ${item.shownIn}` : null}
                    </>
                  ) : (
                    `${item.backend}${item.shownIn ? ` · ${item.shownIn}` : ""}`
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
                onPress={() => {
                  if (steadyRows.landed()) router.push(`/c/${fp}/s/${sidToRoute(item.s.id)}`);
                }}
              />
            </View>
          );
        }}
      />
      {/* The transport banner above the list already explains the pause. */}
      {dimmed ? <StatusOverlay tone="muted" /> : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="New session"
        onPress={newSession}
        style={{
          position: "absolute",
          right: 20,
          bottom: FAB_BOTTOM,
          width: FAB_SIZE,
          height: FAB_SIZE,
          borderRadius: FAB_SIZE / 2,
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
