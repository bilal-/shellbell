import { classifyWebLink, type WebResetReason, type WebTarget } from "@shellbell/protocol";
import { getRandomBytes } from "expo-crypto";
import * as Linking from "expo-linking";
import { Stack, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BackHandler, Keyboard, Pressable, Text, View } from "react-native";
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
import { PageIcon } from "../../../src/web/PageIcon";
import { pageTitle } from "../../../src/web/page-title";
import type { WebSession } from "../../../src/web/web-session";

type Failure = { reason: WebResetReason; detail?: string };

const PAGE_BACKGROUND = "#FFFFFF";

/** How long repeated prompts from a page stay quiet after the person chose Cancel. */
const PROMPT_QUIET_MS = 5_000;

function failureText(failure: Failure, authority: string, name: string, pageName?: string): string {
  switch (failure.reason) {
    case "start-failed":
      return `${pageName ?? "This page"} didn’t start.${failure.detail ? ` “${failure.detail}”` : ""}`;
    case "start-timeout":
      return `${pageName ?? "This page"} didn’t start within 15 seconds.`;
    case "not-found":
      return `${pageName ?? "This page"} is no longer registered on ${name}.`;
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
  const params = useLocalSearchParams<{
    fp: string;
    origin?: string;
    page?: string;
    path?: string;
  }>();
  const { fp, origin, page: pageID } = params;
  const registered = useConnectionsStore((s) =>
    s.byComputer[fp]?.hello?.pages?.find((p) => p.id === pageID),
  );
  const icon = useConnectionsStore((s) =>
    registered?.icon ? s.byComputer[fp]?.pageIcons?.[registered.icon] : undefined,
  );
  const target = useMemo<WebTarget>(
    () => (pageID ? { page: pageID } : { origin: origin ?? "" }),
    [pageID, origin],
  );
  const link = useMemo(() => classifyWebLink(origin ?? ""), [origin]);
  const [resolvedAuthority, setResolvedAuthority] = useState<string | null>(null);
  const authority =
    resolvedAuthority ??
    registered?.address ??
    (link.kind === "local" ? link.origin.authority : (origin ?? "this page"));
  const [loading, setLoading] = useState(true);
  const name = computerName(fp);
  const status = useConnectionsStore((s) => s.byComputer[fp]?.status);
  const quiet = useConnectionsStore((s) => s.byComputer[fp]?.quiet === true);
  const locked = useAppLock((s) => s.locked);
  const [focused, setFocused] = useState(true);
  const live = focused && !locked && nativeWebDoor !== null;
  const ready = live && status === "online" && !quiet;

  const [door, setDoor] = useState<WebDoor | null>(null);
  const [uri, setUri] = useState<string | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [title, setTitle] = useState<string | null>(null);
  const path = useRef(params.path || "/");
  const view = useRef<WebView>(null);
  const shield = useRef<View>(null);
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

  // One door per visit. Reconnection keeps its origin and operation IDs;
  // leaving the page or App Lock ends the visit and clears its data.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` exists to reopen the door.
  useEffect(() => {
    if (!live || !nativeWebDoor) return;
    setLoading(true);
    const native = nativeWebDoor;
    let cancelled = false;
    let opened: WebDoor | null = null;
    const connection = () => connectionManager.get(fp);
    let announced: WebSession | null = null;
    void native
      .clearWebData()
      .catch(() => false)
      .then((cleared) => {
        if (cancelled) return;
        if (!cleared) throw new Error("Page data could not be cleared");
        opened = new WebDoor({
          native,
          target,
          random: getRandomBytes,
          session: () => {
            const c = connection();
            const session =
              c && !useConnectionsStore.getState().byComputer[fp]?.quiet ? c.webSession() : null;
            // A fresh route owns a fresh host. Re-register this view BEFORE any
            // request, including quiet-at-first-open and automatic SSE retries.
            if (session && session !== announced) {
              if (!session.view(target, true)) return null;
              announced = session;
            }
            return session;
          },
          events: {
            authority: (value) => {
              if (!cancelled) setResolvedAuthority(value);
            },
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
            failed: (reason, detail) => {
              if (reason !== "closed") setFailure({ reason, ...(detail && { detail }) });
            },
          },
        });
        setFailure(null);
        setDoor(opened);
        setUri(opened.enter(path.current));
      })
      .catch(() => {
        if (!cancelled) setFailure({ reason: "unreachable" });
      });
    return () => {
      cancelled = true;
      setUri(null);
      setDoor(null);
      opened?.stop();
      announced?.view(target, false);
      void native.clearWebData().catch(() => false);
    };
  }, [live, fp, target, outside, attempt]);

  useEffect(() => {
    if (!door) return;
    if (!ready) door.pause();
    else {
      setFailure(null);
      view.current?.reload();
    }
  }, [ready, door]);

  useEffect(() => {
    if (!ready || failure) {
      Keyboard.dismiss();
      shield.current?.focus();
    }
  }, [ready, failure]);

  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      if (!canGoBack.current) return false;
      view.current?.goBack();
      return true;
    });
    return () => sub.remove();
  }, []);

  const reload = useCallback(() => {
    if (!ready) return;
    setFailure(null);
    if (!door) setAttempt((n) => n + 1);
    else view.current?.reload();
  }, [ready, door]);

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
          title: registered?.name ?? title ?? authority,
          ...(registered && {
            headerTitle: () => (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8, maxWidth: 220 }}>
                <PageIcon id={registered.id} name={registered.name} uri={icon} size={28} />
                <Text
                  numberOfLines={1}
                  style={{ color: tokens.text, fontSize: 17, fontWeight: "600", flexShrink: 1 }}
                >
                  {registered.name}
                </Text>
              </View>
            ),
          }),
          headerBackTitle: name,
          headerRight: () => <HeaderButton icon="reload" label="Reload page" onPress={reload} />,
        }}
      />
      <Text
        style={{ color: tokens.textMuted, paddingHorizontal: 16, paddingBottom: 6, fontSize: 13 }}
        numberOfLines={1}
      >
        {(registered && (resolvedAuthority || registered.address)) || (!pageID && title)
          ? `${authority} on ${name}`
          : `on ${name}`}
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
      {pageID && loading && !failure && !banner ? (
        <Text accessibilityLiveRegion="polite" style={{ color: tokens.textMuted, padding: 12 }}>
          Starting {registered?.name ?? "page"}…
        </Text>
      ) : null}
      <View style={{ flex: 1 }}>
        {uri && door ? (
          <View
            style={{ flex: 1 }}
            pointerEvents={ready && !failure ? "auto" : "none"}
            importantForAccessibility={ready && !failure ? "auto" : "no-hide-descendants"}
          >
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
                if (!state.loading) {
                  setLoading(false);
                  setTitle(pageTitle(state.title, state.url));
                }
                const current = doorRef.current;
                if (current?.owns(state.url)) {
                  const next = state.url.slice(current.origin.length) || "/";
                  if (!next.startsWith("/__shellbell/")) path.current = next;
                }
              }}
              onRenderProcessGone={() => view.current?.reload()}
              onContentProcessDidTerminate={() => view.current?.reload()}
            />
          </View>
        ) : null}
        {(!ready || failure) && (
          <View
            ref={shield}
            focusable
            accessible={!failure}
            accessibilityLabel={banner ?? "Page unavailable"}
            style={{
              position: "absolute",
              top: 0,
              bottom: 0,
              left: 0,
              right: 0,
              backgroundColor: failure ? tokens.bg : "rgba(0,0,0,0.12)",
            }}
          >
            {failure ? (
              <View
                style={{
                  flex: 1,
                  alignItems: "center",
                  justifyContent: "center",
                  padding: 24,
                  gap: 16,
                }}
              >
                <Text style={{ color: tokens.text, fontSize: 16, textAlign: "center" }}>
                  {failureText(failure, authority, name, registered?.name)}
                </Text>
                <Pressable
                  accessibilityRole="button"
                  onPress={reload}
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
            ) : null}
          </View>
        )}
      </View>
      {toast && <Toast text={toast} onDone={() => setToast(null)} />}
    </View>
  );
}
