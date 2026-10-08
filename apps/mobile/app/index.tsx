import { FlashList } from "@shopify/flash-list";
import { Link, useRouter } from "expo-router";
import { Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useComputersStore } from "../src/store/computers";
import { useConnectionsStore } from "../src/store/connections";
import { useNetworkStore } from "../src/store/network";
import { tokens } from "../src/theme/tokens";
import { AppIcon } from "../src/ui/AppIcon";
import { Card } from "../src/ui/Card";
import { EmptyState } from "../src/ui/EmptyState";
import { Pill } from "../src/ui/Pill";
import { transportPresentation } from "../src/util/transport-state";

const ERROR_TEXT: Record<string, string> = {
  unpaired: "unpaired",
  "re-pair": "re-pair needed",
  superseded: "open on another device",
  rejected: "rejected by relay",
  relay: "relay error",
  "upgrade-required": "update required",
  storage: "pairing unavailable",
};

export default function Computers() {
  const insets = useSafeAreaInsets();
  const computers = useComputersStore((s) => s.computers);
  const conns = useConnectionsStore((s) => s.byComputer);
  const network = useNetworkStore((s) => s.snapshot);
  const router = useRouter();
  return (
    <View
      style={{
        flex: 1,
        backgroundColor: tokens.bg,
        paddingLeft: insets.left,
        paddingRight: insets.right,
      }}
    >
      {computers.length === 0 ? (
        <EmptyState
          text="No computers yet."
          action={{ label: "Pair a computer", onPress: () => router.push("/pair") }}
        />
      ) : (
        <FlashList
          data={computers}
          keyExtractor={(c) => c.fp}
          contentContainerStyle={{ padding: 12, paddingBottom: 112 }}
          renderItem={({ item }) => {
            const c = conns[item.fp];
            const accentKey = item.accent as keyof typeof tokens.accents;
            const accent = tokens.accents[accentKey] ?? tokens.accents.emerald;
            const transport = transportPresentation(c, network);
            const label = c?.error
              ? (ERROR_TEXT[c.error] ?? "needs attention")
              : network.internet === "offline" && c?.status !== "online"
                ? "no internet"
                : c?.offlineReason === "computer"
                  ? "computer offline"
                  : transport.label;
            return (
              <View>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`${item.name}, ${label}, ${c?.sessions.length ?? 0} ${c?.sessions.length === 1 ? "session" : "sessions"}`}
                  accessibilityHint="Open terminal sessions"
                  onPress={() => router.push(`/c/${item.fp}`)}
                >
                  <Card accent={accent}>
                    <Text style={{ color: tokens.text, fontSize: 17, fontWeight: "600" }}>
                      {item.name}
                    </Text>
                    <View
                      style={{
                        flexDirection: "row",
                        gap: 8,
                        marginTop: 6,
                        alignItems: "center",
                      }}
                    >
                      <Pill
                        color={
                          transport.tone === "direct"
                            ? tokens.accents.emerald
                            : transport.tone === "relay"
                              ? tokens.accents.amber
                              : tokens.textFaint
                        }
                        text={label}
                      />
                      <Text style={{ color: tokens.textMuted }}>
                        {c?.sessions.length ?? 0}{" "}
                        {c?.sessions.length === 1 ? "session" : "sessions"}
                      </Text>
                    </View>
                  </Card>
                </Pressable>
              </View>
            );
          }}
        />
      )}
      {computers.length > 0 ? (
        <Link href="/pair" asChild>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Pair a computer"
            style={{
              position: "absolute",
              right: 20 + insets.right,
              bottom: 32,
              width: 56,
              height: 56,
              borderRadius: 28,
              backgroundColor: tokens.accents.emerald,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <AppIcon name="plus" color={tokens.bg} size={26} />
          </Pressable>
        </Link>
      ) : null}
    </View>
  );
}
