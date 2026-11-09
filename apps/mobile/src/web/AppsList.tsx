import type { WebPage } from "@shellbell/protocol";
import { router } from "expo-router";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useConnectionsStore } from "../store/connections";
import { tokens } from "../theme/tokens";
import { PageIcon } from "./PageIcon";
export function AppsList({ fp, pages }: { fp: string; pages: readonly WebPage[] }) {
  const insets = useSafeAreaInsets();
  const icons = useConnectionsStore((s) => s.byComputer[fp]?.pageIcons);
  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{ padding: 12, gap: 10, paddingBottom: 24 + insets.bottom }}
    >
      {pages.map((page) => (
        <Pressable
          key={page.id}
          accessibilityRole="button"
          accessibilityLabel={`${page.name}${page.skipped ? `. Unavailable. ${page.skipped.reason}${page.skipped.fix ? `. ${page.skipped.fix}` : ""}` : ""}`}
          accessibilityState={{ disabled: !!page.skipped }}
          disabled={!!page.skipped}
          onPress={() => router.push({ pathname: "/c/[fp]/page", params: { fp, page: page.id } })}
          style={({ pressed }) => ({
            padding: 16,
            gap: 7,
            borderRadius: tokens.radius.md,
            borderWidth: 1,
            borderColor: tokens.border,
            backgroundColor: tokens.surface,
            opacity: page.skipped ? 0.6 : pressed ? 0.72 : 1,
          })}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
            <PageIcon
              id={page.id}
              name={page.name}
              uri={page.icon ? icons?.[page.icon] : undefined}
            />
            <Text
              numberOfLines={1}
              style={{ flex: 1, color: tokens.text, fontSize: 16, fontWeight: "600" }}
            >
              {page.name}
            </Text>
          </View>
          {page.description ? (
            <Text
              numberOfLines={3}
              style={{ color: tokens.textMuted, fontSize: 13, lineHeight: 18 }}
            >
              {page.description}
            </Text>
          ) : null}
          {page.address ? (
            <Text numberOfLines={1} style={{ color: tokens.textMuted, fontSize: 12 }}>
              {page.address}
            </Text>
          ) : null}
          {page.skipped ? (
            <>
              <Text numberOfLines={3} style={{ color: tokens.text, fontSize: 13, lineHeight: 18 }}>
                {page.skipped.reason}
              </Text>
              {page.skipped.fix ? (
                <Text
                  numberOfLines={3}
                  style={{ color: tokens.textMuted, fontSize: 12, lineHeight: 17 }}
                >
                  {page.skipped.fix}
                </Text>
              ) : null}
            </>
          ) : null}
          {page.iconIssue ? (
            <Text numberOfLines={2} style={{ color: tokens.textMuted, fontSize: 12 }}>
              Icon unavailable: {page.iconIssue.reason}
            </Text>
          ) : null}
        </Pressable>
      ))}
    </ScrollView>
  );
}
