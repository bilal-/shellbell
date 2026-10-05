import { useLocalSearchParams, useRouter } from "expo-router";
import { Alert, Pressable, Text } from "react-native";
import { connectionManager } from "../net/manager";
import { useConnectionsStore } from "../store/connections";
import { tokens } from "../theme/tokens";
import { asBackendName, backendOf, newSessionLabel } from "../util/backends";
import { sidFromRoute, sidToRoute } from "../util/routes";

/**
 * Header `⋯` for the session screen: actions are filtered by the capabilities `hello.backends`
 * reports for *this session's* backend (spec 10.6). `session.create`/`session.focus` reach the
 * agent's strict parser, so an unknown backend only ever offers "Bring to front" (which needs no
 * strict `BackendName`, just a `sessionId`).
 */
export function SessionMenuButton({ fp }: { fp: string }) {
  const { sid } = useLocalSearchParams<{ sid?: string }>();
  const router = useRouter();
  const conn = useConnectionsStore((s) => s.byComputer[fp]);
  const sessionId = sid ? sidFromRoute(sid) : undefined;
  const session = sessionId ? conn?.sessions.find((s) => s.id === sessionId) : undefined;

  if (!sessionId || !session) return null;

  const backend = backendOf(sessionId);
  const caps = conn?.hello?.backends.find((b) => b.name === backend)?.capabilities;
  const strict = asBackendName(backend);

  const goToAck = (ack: { sessionId?: string }) => {
    if (ack.sessionId) router.push(`/c/${fp}/s/${sidToRoute(ack.sessionId)}`);
  };
  const focus = () => {
    const c = connectionManager.get(fp);
    if (c)
      void c
        .request({ type: "session.focus", reqId: c.newReqId(), sessionId })
        .catch(() => undefined);
  };
  const createTab = (name: NonNullable<typeof strict>) => {
    const c = connectionManager.get(fp);
    if (!c) return;
    void c
      .request({ type: "session.create", reqId: c.newReqId(), in: { kind: "tab", backend: name } })
      .then(goToAck)
      .catch(() => undefined);
  };
  const split = (direction: "vertical" | "horizontal") => {
    const c = connectionManager.get(fp);
    if (!c) return;
    void c
      .request({
        type: "session.create",
        reqId: c.newReqId(),
        in: { kind: "split", sessionId, direction },
      })
      .then(goToAck)
      .catch(() => undefined);
  };

  const onPress = () => {
    const actions: { text: string; onPress?: () => void; style?: "cancel" | "destructive" }[] = [];
    if (caps?.focus) actions.push({ text: "Bring to front on Mac", onPress: focus });
    if (caps?.createSession && strict !== null) {
      actions.push({ text: newSessionLabel(strict), onPress: () => createTab(strict) });
      actions.push({ text: "Split vertical", onPress: () => split("vertical") });
      actions.push({ text: "Split horizontal", onPress: () => split("horizontal") });
    }
    actions.push({ text: "Cancel", style: "cancel" });
    Alert.alert(session.title, undefined, actions);
  };

  return (
    <Pressable accessibilityLabel="Session actions" onPress={onPress} hitSlop={8}>
      <Text style={{ color: tokens.textMuted, fontSize: 20 }}>⋯</Text>
    </Pressable>
  );
}
