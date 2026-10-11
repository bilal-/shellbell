import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { Modal, Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { connectionManager } from "../net/manager";
import { useCloseWhenHidden } from "../security/screen-hidden";
import { useConnectionsStore } from "../store/connections";
import { tokens } from "../theme/tokens";
import {
  activeBackends,
  asBackendName,
  backendOf,
  creationErrorText,
  newSessionLabel,
  preferredLaunchTarget,
} from "../util/backends";
import { sidToRoute } from "../util/routes";
import { sessionSubtitle, sessionTitle } from "../util/session-label";
import { HeaderButton } from "./HeaderButton";

/**
 * Session actions are filtered by the capabilities `hello.backends`
 * reports for *this session's* backend (spec 10.6). `session.create`/`session.focus` reach the
 * agent's strict parser, so an unknown backend only ever offers "Bring to front" (which needs no
 * strict `BackendName`, just a `sessionId`).
 */
export function SessionMenuButton({ fp, sessionId }: { fp: string; sessionId: string }) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [open, setOpen] = useState(false);
  const hidden = useCloseWhenHidden(open, () => setOpen(false));
  // Lives in the session header: close with its screen so it cannot re-present over another.
  useFocusEffect(useCallback(() => () => setOpen(false), []));
  const [pending, setPending] = useState(false);
  const requestPending = useRef(false);
  const conn = useConnectionsStore((s) => s.byComputer[fp]);
  const session = sessionId ? conn?.sessions.find((s) => s.id === sessionId) : undefined;

  if (!sessionId || !session) return null;
  const subtitle = sessionSubtitle(session);

  const backend = backendOf(sessionId);
  const caps = activeBackends(conn?.hello).find((b) => b.name === backend)?.capabilities;
  const strict = asBackendName(backend, conn?.hello?.backendCatalog);
  const connected = conn?.status === "online" && conn.transport?.ready !== false;
  const toast = (message: string) =>
    useConnectionsStore.getState().patch(fp, () => ({ toast: message }));

  const goToAck = (ack: { sessionId?: string; error?: string }) => {
    if (ack.sessionId) router.push(`/c/${fp}/s/${sidToRoute(ack.sessionId)}`);
    else
      toast(
        creationErrorText(ack.error) ??
          "Could not create a session. Check the terminal app on your computer.",
      );
  };
  const run = async (action: () => Promise<void>) => {
    if (requestPending.current) return;
    requestPending.current = true;
    setPending(true);
    setOpen(false);
    try {
      await action();
    } catch {
      toast("No response from your computer. Check the session list before trying again.");
    } finally {
      requestPending.current = false;
      setPending(false);
    }
  };
  const focus = async () => {
    const c = connectionManager.get(fp);
    if (!c?.online) throw new Error("offline");
    const ack = await c.request({ type: "session.focus", reqId: c.newReqId(), sessionId });
    if (!ack.ok) toast("Could not bring this session to the front on your computer.");
  };
  const createTab = async (name: NonNullable<typeof strict>, host?: string) => {
    const c = connectionManager.get(fp);
    if (!c?.online) throw new Error("offline");
    await c
      .request({
        type: "session.create",
        reqId: c.newReqId(),
        in: { kind: "tab", backend: name, ...(host ? { host } : {}) },
      })
      .then(goToAck);
  };
  const split = async (direction: "vertical" | "horizontal") => {
    const c = connectionManager.get(fp);
    if (!c?.online) throw new Error("offline");
    await c
      .request({
        type: "session.create",
        reqId: c.newReqId(),
        in: { kind: "split", sessionId, direction },
      })
      .then(goToAck);
  };

  const actions: { text: string; onPress: () => Promise<void> }[] = [];
  if (caps?.focus) actions.push({ text: "Bring to front on computer", onPress: focus });
  if (caps?.createSession && strict !== null) {
    // New sessions must open on the computer: iTerm2 tabs do; other engines open in a terminal
    // app the computer advertises, or are not offered at all.
    const target =
      strict === "iterm2"
        ? undefined
        : preferredLaunchTarget(strict, conn?.hello?.sessionLaunchTargets);
    if (strict === "iterm2" || target)
      actions.push({
        text: target
          ? `${newSessionLabel(strict, conn?.hello?.backendCatalog)} in ${target.label}`
          : newSessionLabel(strict, conn?.hello?.backendCatalog),
        onPress: () => createTab(strict, target?.host),
      });
    // A split lands in the session's own window. iTerm2 shows it; the computer allows a tmux
    // split only while a tmux window on the computer shows that session.
    if (strict === "iterm2" || strict === "tmux") {
      actions.push({ text: "Split vertical", onPress: () => split("vertical") });
      actions.push({ text: "Split horizontal", onPress: () => split("horizontal") });
    }
  }

  return (
    <>
      <HeaderButton
        icon="more"
        label="Session actions"
        disabled={pending}
        onPress={() => setOpen(true)}
      />
      <Modal
        transparent
        animationType="fade"
        visible={open && !hidden}
        onRequestClose={() => setOpen(false)}
        supportedOrientations={["portrait", "landscape-left", "landscape-right"]}
      >
        <View
          style={{
            flex: 1,
            justifyContent: "flex-end",
            alignItems: "center",
            paddingLeft: Math.max(16, insets.left),
            paddingRight: Math.max(16, insets.right),
            paddingTop: Math.max(16, insets.top),
            paddingBottom: Math.max(16, insets.bottom),
            backgroundColor: "rgba(0,0,0,0.65)",
          }}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Dismiss session actions"
            onPress={() => setOpen(false)}
            style={{ position: "absolute", top: 0, bottom: 0, left: 0, right: 0 }}
          />
          <View
            accessibilityViewIsModal
            style={{
              width: "100%",
              maxWidth: 560,
              maxHeight: "90%",
              borderRadius: tokens.radius.lg,
              borderWidth: 1,
              borderColor: tokens.border,
              backgroundColor: tokens.surface2,
              padding: 20,
              gap: 12,
            }}
          >
            <View style={{ gap: 2 }}>
              <Text
                accessibilityRole="header"
                numberOfLines={1}
                style={{ color: tokens.text, fontSize: 20, fontWeight: "600" }}
              >
                {sessionTitle(session)}
              </Text>
              {subtitle ? (
                <Text numberOfLines={2} style={{ color: tokens.textMuted, fontSize: 13 }}>
                  {subtitle.text}
                </Text>
              ) : null}
            </View>
            {!connected ? (
              <Text style={{ color: tokens.textMuted }}>
                Reconnect to your computer to use session actions.
              </Text>
            ) : null}
            {actions.length === 0 ? (
              <Text style={{ color: tokens.textMuted }}>
                This terminal does not offer session actions.
              </Text>
            ) : null}
            <ScrollView>
              {actions.map((action) => (
                <Pressable
                  key={action.text}
                  accessibilityRole="button"
                  accessibilityLabel={action.text}
                  disabled={!connected || pending}
                  accessibilityState={{ disabled: !connected || pending }}
                  onPress={() => void run(action.onPress)}
                  style={{ minHeight: 48, justifyContent: "center", opacity: connected ? 1 : 0.4 }}
                >
                  <Text style={{ color: tokens.text, fontSize: 16 }}>{action.text}</Text>
                </Pressable>
              ))}
            </ScrollView>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Cancel session actions"
              onPress={() => setOpen(false)}
              style={{ minHeight: 48, alignItems: "center", justifyContent: "center" }}
            >
              <Text style={{ color: tokens.text, fontSize: 15 }}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </>
  );
}
