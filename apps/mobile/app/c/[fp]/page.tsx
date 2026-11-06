import { classifyWebLink, type WebResetReason, type WebTarget } from "@shellbell/protocol";
import { getRandomBytes } from "expo-crypto";
import * as Linking from "expo-linking";
import { Stack, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BackHandler, Pressable, Text, View } from "react-native";
import { WebView } from "react-native-webview";
import { connectionManager } from "../../../src/net/manager";
import { useAppLock } from "../../../src/security/app-lock";
import { useConnectionsStore } from "../../../src/store/connections";
import { tokens } from "../../../src/theme/tokens";
import { HeaderButton } from "../../../src/ui/HeaderButton";
import { Toast } from "../../../src/ui/Toast";
import { WebDoor } from "../../../src/web/door";
import { computerName, openLocalLink } from "../../../src/web/links";
import { nativeWebDoor } from "../../../src/web/native-door";
import { pageTitle } from "../../../src/web/page-title";

type Failure = { reason: WebResetReason; detail?: string };

const PAGE_BACKGROUND = "#FFFFFF";

/** How long repeated prompts from a page stay quiet after the person chose Cancel. */
const PROMPT_QUIET_MS = 5_000;

function failureText(failure: Failure, authority: string, name: string): string {
  switch (failure.reason) {
    case "unreachable":
      return `Nothing is answering at ${authority} on ${name}.`;
    case "timeout":
      return `${authority} on ${name} took too long to answer.`;
    case "refused":
      return `${name} won't open ${authority}.`;
    default:
      return failure.detail ?? `${name} couldn't load this page.`;
  }
}

/**
 * A web page served by the paired computer, shown through the phone's local web door. The page
 * view is a throwaway private session: the door clears it at every open and close, every cookie
 * stays on the computer, and nothing is kept after the page closes.
 */
export default function PageScreen() {
  const params = useLocalSearchParams<{ fp: string; origin: string; path?: string }>();
  const { fp, origin } = params;
  const target = useMemo<WebTarget>(() => ({ origin }), [origin]);
  const link = useMemo(() => classifyWebLink(origin), [origin]);
  const authority = link.kind === "local" ? link.origin.authority : origin;
  const name = computerName(fp);
  const status = useConnectionsStore((s) => s.byComputer[fp]?.status);
  const quiet = useConnectionsStore((s) => s.byComputer[fp]?.quiet === true);
  const locked = useAppLock((s) => s.locked);
  const [focused, setFocused] = useState(true);
  const live = focused && !locked && status === "online" && nativeWebDoor !== null;

  const [door, setDoor] = useState<WebDoor | null>(null);
  const [uri, setUri] = useState<string | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [title, setTitle] = useState<string | null>(null);
  const path = useRef(params.path || "/");
  const view = useRef<WebView>(null);
  const canGoBack = useRef(false);
  const quietUntil = useRef(0);
  const doorRef = useRef<WebDoor | null>(null);
  doorRef.current = door;

  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      return () => setFocused(false);
    }, []),
  );

  // A link to this page under another of its names loads here, not as a second page.
  const inPage = useCallback((url: string): boolean => {
    const address = doorRef.current?.inPage(url);
    if (!address) return false;
    view.current?.injectJavaScript(`location.assign(${JSON.stringify(address)});true;`);
    return true;
  }, []);

  const outside = useCallback(
    (url: string) => {
      const kind = classifyWebLink(url).kind;
      if (kind === "public") void Linking.openURL(url).catch(() => {});
      else if (kind === "local" || kind === "secure-local") {
        if (Date.now() < quietUntil.current) return;
        openLocalLink(fp, url, () => {
          quietUntil.current = Date.now() + PROMPT_QUIET_MS;
        });
      }
    },
    [fp],
  );

  // One door per visit: a new port and key whenever the page comes back, or on Try Again.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` exists to reopen the door.
  useEffect(() => {
    if (!live || !nativeWebDoor) return;
    const native = nativeWebDoor;
    let cancelled = false;
    let opened: WebDoor | null = null;
    const connection = () => connectionManager.get(fp);
    void native
      .clearWebData()
      .catch(() => false)
      .then(() => {
        if (cancelled) return;
        opened = new WebDoor({
          native,
          target,
          random: getRandomBytes,
          session: () => {
            const c = connection();
            return c && !useConnectionsStore.getState().byComputer[fp]?.quiet
              ? c.webSession()
              : null;
          },
          events: {
            leave: (address, document) => {
              if (document) outside(address);
            },
            blocked: (blocked) => {
              const shown = classifyWebLink(blocked);
              setToast(
                shown.kind === "local"
                  ? `This page tried to load from ${shown.origin.authority}, which Shellbell can't reach from inside a page.`
                  : "This page tried to load something Shellbell blocks inside pages.",
              );
            },
            download: () => setToast("Downloads aren't supported here yet."),
            failed: (reason, detail) => setFailure({ reason, ...(detail && { detail }) }),
          },
        });
        connection()?.webSession()?.view(target, true);
        setFailure(null);
        setDoor(opened);
        setUri(opened.enter(path.current));
      });
    return () => {
      cancelled = true;
      setUri(null);
      setDoor(null);
      opened?.stop();
      connection()?.webSession()?.view(target, false);
      void native.clearWebData().catch(() => false);
    };
  }, [live, fp, target, outside, attempt]);

  // The computer answered again after going quiet: reload, as after a reconnect.
  const wasQuiet = useRef(false);
  useEffect(() => {
    if (wasQuiet.current && !quiet) view.current?.reload();
    wasQuiet.current = quiet;
  }, [quiet]);

  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      if (!canGoBack.current) return false;
      view.current?.goBack();
      return true;
    });
    return () => sub.remove();
  }, []);

  const reload = useCallback(() => {
    if (failure || !door) setAttempt((n) => n + 1);
    else view.current?.reload();
  }, [failure, door]);

  const banner =
    status !== "online" || quiet
      ? `Reconnecting to ${name}…`
      : nativeWebDoor === null
        ? "Pages aren't available on this phone yet."
        : null;

  return (
    <View style={{ flex: 1, backgroundColor: tokens.bg }}>
      <Stack.Screen
        options={{
          // The page names itself; the address stays underneath, since any page can pick its title.
          title: title ?? authority,
          headerBackTitle: name,
          headerRight: () => <HeaderButton icon="reload" label="Reload page" onPress={reload} />,
        }}
      />
      <Text
        style={{ color: tokens.textMuted, paddingHorizontal: 16, paddingBottom: 6, fontSize: 13 }}
        numberOfLines={1}
      >
        {title ? `${authority} on ${name}` : `on ${name}`}
      </Text>
      {banner && (
        <Text
          accessibilityLiveRegion="polite"
          style={{
            color: tokens.text,
            backgroundColor: tokens.surface2,
            padding: 10,
            textAlign: "center",
          }}
        >
          {banner}
        </Text>
      )}
      {failure ? (
        <View
          style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 16 }}
        >
          <Text style={{ color: tokens.text, fontSize: 16, textAlign: "center" }}>
            {failureText(failure, authority, name)}
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => setAttempt((n) => n + 1)}
            style={{
              backgroundColor: tokens.accents.emerald,
              borderRadius: 10,
              paddingHorizontal: 20,
              paddingVertical: 12,
            }}
          >
            <Text style={{ color: tokens.bg, fontWeight: "600" }}>Try Again</Text>
          </Pressable>
        </View>
      ) : uri && door ? (
        <WebView
          ref={view}
          source={{ uri }}
          originWhitelist={["*"]}
          incognito
          sharedCookiesEnabled={false}
          thirdPartyCookiesEnabled={false}
          setSupportMultipleWindows={false}
          allowFileAccess={false}
          javaScriptEnabled
          domStorageEnabled
          // A page with no background of its own expects a browser's white, not the app's black.
          style={{ flex: 1, backgroundColor: PAGE_BACKGROUND }}
          onShouldStartLoadWithRequest={(request) => {
            if (doorRef.current?.owns(request.url)) return true;
            if (request.url === "about:blank") return true;
            if (!inPage(request.url)) outside(request.url);
            return false;
          }}
          onOpenWindow={(event) => {
            const url = event.nativeEvent.targetUrl;
            if (!inPage(url)) outside(url);
          }}
          onNavigationStateChange={(state) => {
            canGoBack.current = state.canGoBack;
            if (!state.loading) setTitle(pageTitle(state.title, state.url));
            const current = doorRef.current;
            if (current?.owns(state.url)) {
              const next = state.url.slice(current.origin.length) || "/";
              if (!next.startsWith("/__shellbell/")) path.current = next;
            }
          }}
          onRenderProcessGone={() => view.current?.reload()}
          onContentProcessDidTerminate={() => view.current?.reload()}
        />
      ) : (
        <View style={{ flex: 1 }} />
      )}
      {toast && <Toast text={toast} onDone={() => setToast(null)} />}
    </View>
  );
}
