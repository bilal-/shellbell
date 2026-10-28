import { preferredLaunchTarget } from "@shellbell/protocol";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { Platform, Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { connectionManager } from "../net/manager";
import { useCloseWhenHidden } from "../security/screen-hidden";
import { useConnectionsStore } from "../store/connections";
import { newSessionSize } from "../terminal/new-session-size";
import { tokens } from "../theme/tokens";
import {
  activeBackends,
  asBackendName,
  backendOf,
  creationErrorText,
  newSessionLabel,
} from "../util/backends";
import { sidToRoute } from "../util/routes";
import { sessionSubtitle, sessionTitle } from "../util/session-label";
import { AppIcon } from "./AppIcon";
import { useFocusScope } from "./focus-scope";
import { HeaderButton } from "./HeaderButton";
import { Sheet } from "./Sheet";

/** Phone view controls. Conversation choices also start/stop the consented computer subscription. */
export interface SessionViewActions {
  reading: boolean;
  onToggleReading: () => void;
  conversation?: {
    active: boolean;
    available: boolean;
    onConversation: () => void;
    onTerminal: () => void;
  };
  /** Omitted when the visible view cannot search (Reading view). */
  onSearch?: () => void;
  onSelectText?: () => void;
  /** Omitted when this session's terminal does not accept mouse clicks. */
  mouse?: { enabled: boolean; available: boolean; onToggle: () => void };
}

/**
 * Session actions are filtered by the capabilities `hello.backends`
 * reports for *this session's* backend (spec 10.6). `session.create`/`session.focus` reach the
 * agent's strict parser, so an unknown backend only ever offers "Bring to front" (which needs no
 * strict `BackendName`, just a `sessionId`).
 */
export function SessionMenuButton({
  fp,
  sessionId,
  view,
}: {
  fp: string;
  sessionId: string;
  view?: SessionViewActions;
}) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [open, setOpen] = useState(false);
  const hidden = useCloseWhenHidden(open, () => setOpen(false));
  const afterClose = useRef<(() => void) | null>(null);
  // Lives in the session header: close with its screen so it cannot re-present over another.
  useFocusEffect(
    useCallback(
      () => () => {
        afterClose.current = null;
        setOpen(false);
      },
      [],
    ),
  );
  const screenFocus = useFocusScope();
  const [pending, setPending] = useState(false);
  const requestPending = useRef(false);
  const conn = useConnectionsStore((s) => s.byComputer[fp]);
  const session = sessionId ? conn?.sessions.find((s) => s.id === sessionId) : undefined;

  if (!sessionId || (!session && !view)) return null;
  const subtitle = session ? sessionSubtitle(session) : undefined;

  const backend = backendOf(sessionId);
  const caps = activeBackends(conn?.hello).find((b) => b.name === backend)?.capabilities;
  const strict = asBackendName(backend, conn?.hello?.backendCatalog);
  const connected = conn?.status === "online" && conn.transport?.ready !== false;
  const toast = (message: string) =>
    useConnectionsStore.getState().patch(fp, () => ({ toast: message }));
  /** iOS presents one modal at a time: wait until the menu has animated out. */
  const closeThen = (next: () => void) => {
    if (Platform.OS === "ios") {
      afterClose.current = next;
      setOpen(false);
      return;
    }
    setOpen(false);
    next();
  };

  const goToAck = (focused: () => boolean) => (ack: { sessionId?: string; error?: string }) => {
    if (ack.sessionId) {
      // The person moved on meanwhile; the session exists and appears in its list.
      if (focused()) router.push(`/c/${fp}/s/${sidToRoute(ack.sessionId)}`);
    } else
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
    const focused = screenFocus.start();
    const initialSize = newSessionSize(insets);
    await c
      .request({
        type: "session.create",
        reqId: c.newReqId(),
        in: {
          kind: "tab",
          backend: name,
          ...(host ? { host } : {}),
          ...(initialSize ? { initialSize } : {}),
        },
      })
      .then(goToAck(focused));
  };
  const split = async (direction: "vertical" | "horizontal") => {
    const c = connectionManager.get(fp);
    if (!c?.online) throw new Error("offline");
    const focused = screenFocus.start();
    await c
      .request({
        type: "session.create",
        reqId: c.newReqId(),
        in: { kind: "split", sessionId, direction },
      })
      .then(goToAck(focused));
  };

  const actions: { text: string; onPress: () => Promise<void> }[] = [];
  if (session && caps?.focus) actions.push({ text: "Bring to front on computer", onPress: focus });
  if (session && caps?.createSession && strict !== null) {
    // New sessions must open on the computer: iTerm2 tabs do; other engines open in a terminal
    // app the computer advertises, or are not offered at all.
    // The app already showing this session first, so a new session opens beside it.
    const targets = conn?.hello?.sessionLaunchTargets;
    const target =
      strict === "iterm2"
        ? undefined
        : (targets?.find(
            (entry) => entry.backend === strict && session.shownIn?.includes(entry.label),
          ) ?? preferredLaunchTarget(strict, targets));
    if (strict === "iterm2" || target)
      actions.push({
        text: target
          ? `${newSessionLabel(strict, conn?.hello?.backendCatalog)} in ${target.label}`
          : newSessionLabel(strict, conn?.hello?.backendCatalog),
        onPress: () => createTab(strict, target?.host),
      });
    else {
      // Say why rather than hiding it, e.g. a herdr program that does not match the running Herdr.
      const issue = conn?.hello?.sessionLaunchIssues?.find((entry) => entry.backend === strict);
      if (issue)
        actions.push({
          text: newSessionLabel(strict, conn?.hello?.backendCatalog),
          onPress: async () => toast(issue.reason),
        });
    }
    // A split lands in the session's own window. iTerm2 shows it; the computer allows a tmux
    // split only while a tmux window on the computer shows that session.
    if (strict === "iterm2" || strict === "tmux") {
      actions.push({ text: "Split vertical", onPress: () => split("vertical") });
      actions.push({ text: "Split horizontal", onPress: () => split("horizontal") });
    }
  }

  const local: {
    text: string;
    /** One line saying what the choice is for, under its name. */
    detail?: string;
    onPress: () => void;
    checked?: boolean;
    disabled?: boolean;
  }[] = view
    ? [
        ...(view.conversation
          ? [
              {
                text: "Chat",
                detail: "The whole session, sized for your phone. Scroll back to the start.",
                onPress: view.conversation.onConversation,
                checked: view.conversation.active,
                disabled: !view.conversation.available,
              },
              {
                text: "Terminal",
                detail: "Exactly what's on your computer's screen. Use it for menus and prompts.",
                onPress: view.conversation.onTerminal,
                checked: !view.conversation.active,
              },
            ]
          : []),
        {
          text: "Reading view",
          detail: "The terminal's text as paragraphs that fit your phone, easy to read and copy.",
          onPress: view.onToggleReading,
          checked: view.reading,
        },
        ...(view.mouse
          ? [
              {
                text: "Terminal mouse",
                detail: view.mouse.available
                  ? "Taps click inside the program, for apps you can use with a mouse."
                  : "This program doesn't take mouse clicks.",
                onPress: view.mouse.onToggle,
                checked: view.mouse.enabled,
                disabled: !view.mouse.available,
              },
            ]
          : []),
        ...(view.onSearch ? [{ text: "Search terminal history", onPress: view.onSearch }] : []),
        ...(view.onSelectText ? [{ text: "Select text", onPress: view.onSelectText }] : []),
      ]
    : [];
  const row = {
    minHeight: 48,
    flexDirection: "row" as const,
    alignItems: "center" as const,
    justifyContent: "space-between" as const,
    gap: 12,
  };

  return (
    <>
      <HeaderButton
        icon="more"
        label="Session actions"
        disabled={pending}
        onPress={() => setOpen(true)}
      />
      <Sheet
        visible={open && !hidden}
        onClose={() => setOpen(false)}
        onDismiss={() => {
          const next = afterClose.current;
          afterClose.current = null;
          next?.();
        }}
        dismissLabel="Dismiss session actions"
      >
        <View style={{ gap: 2 }}>
          <Text
            accessibilityRole="header"
            numberOfLines={1}
            style={{ color: tokens.text, fontSize: 20, fontWeight: "600" }}
          >
            {session ? sessionTitle(session) : "Session"}
          </Text>
          {subtitle ? (
            <Text numberOfLines={2} style={{ color: tokens.textMuted, fontSize: 13 }}>
              {subtitle.text}
            </Text>
          ) : null}
        </View>
        <ScrollView>
          {local.map((item) => (
            <Pressable
              key={item.text}
              accessibilityRole={item.checked === undefined ? "button" : "switch"}
              accessibilityLabel={item.text}
              accessibilityHint={item.detail}
              accessibilityState={{
                disabled: item.disabled === true,
                ...(item.checked === undefined ? {} : { checked: item.checked }),
              }}
              disabled={item.disabled}
              onPress={() => closeThen(item.onPress)}
              style={({ pressed }) => ({
                ...row,
                opacity: item.disabled ? 0.4 : pressed ? 0.6 : 1,
              })}
            >
              <View style={{ flex: 1, gap: 2, paddingVertical: item.detail ? 6 : 0 }}>
                <Text style={{ color: tokens.text, fontSize: 16 }}>{item.text}</Text>
                {item.detail ? (
                  <Text style={{ color: tokens.textMuted, fontSize: 13 }}>{item.detail}</Text>
                ) : null}
              </View>
              {item.checked ? (
                <AppIcon name="check" size={18} color={tokens.accents.emerald} />
              ) : null}
            </Pressable>
          ))}
          {session && !connected ? (
            <Text style={{ color: tokens.textMuted, paddingVertical: 6 }}>
              Reconnect to your computer to use session actions.
            </Text>
          ) : null}
          {session && actions.length === 0 && !view ? (
            <Text style={{ color: tokens.textMuted }}>
              This terminal does not offer session actions.
            </Text>
          ) : null}
          {actions.map((action) => (
            <Pressable
              key={action.text}
              accessibilityRole="button"
              accessibilityLabel={action.text}
              disabled={!connected || pending}
              accessibilityState={{ disabled: !connected || pending }}
              onPress={() => void run(action.onPress)}
              style={{ ...row, opacity: connected ? 1 : 0.4 }}
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
      </Sheet>
    </>
  );
}
