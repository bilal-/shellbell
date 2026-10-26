import { Stack } from "expo-router";
import { useMemo, useState } from "react";
import { Platform, Pressable, SectionList, Text, TextInput, View } from "react-native";
import credits from "../src/credits/gen/credits.json";
import { terminalLicenses } from "../src/terminal/gen/document";
import { FONT, tokens } from "../src/theme/tokens";

interface Credit {
  readonly name: string;
  readonly version: string;
  readonly license: string;
  /** Index into `credits.texts`, or the text itself for the terminal's combined notice. */
  readonly text: number | string;
}

/** What the app ships on this platform: other platforms' native libraries aren't in it. */
function shipped(): { title: string; data: Credit[] }[] {
  const native = Platform.OS === "ios" ? "iOS libraries" : "Android libraries";
  return [
    {
      title: "Terminal",
      data: [
        {
          name: "xterm.js, its addons and JetBrains Mono Nerd Font",
          version: "",
          license: "MIT · OFL-1.1",
          text: terminalLicenses,
        },
      ],
    },
    ...credits.sections
      .filter((section) => section.title === "JavaScript libraries" || section.title === native)
      .map((section) => ({ title: section.title, data: section.items as Credit[] })),
  ];
}

function Row({ credit }: { credit: Credit }) {
  const [open, setOpen] = useState(false);
  const text = typeof credit.text === "string" ? credit.text : credits.texts[credit.text];
  return (
    <View style={{ borderBottomWidth: 1, borderBottomColor: tokens.border }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${credit.name}, ${credit.license}`}
        onPress={() => setOpen((value) => !value)}
        style={{
          minHeight: 48,
          justifyContent: "center",
          paddingHorizontal: 20,
          paddingVertical: 8,
        }}
      >
        <Text style={{ color: tokens.text, fontSize: 15 }}>{credit.name}</Text>
        <Text style={{ color: tokens.textMuted, fontSize: 13 }}>
          {[credit.version, credit.license].filter(Boolean).join(" · ")}
        </Text>
      </Pressable>
      {open ? (
        <Text
          selectable
          style={{
            color: tokens.textMuted,
            fontFamily: FONT.regular,
            fontSize: 11,
            lineHeight: 16,
            paddingHorizontal: 20,
            paddingBottom: 16,
          }}
        >
          {text}
        </Text>
      ) : null}
    </View>
  );
}

export default function Licenses() {
  const [query, setQuery] = useState("");
  const all = useMemo(shipped, []);
  const sections = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return all;
    return all
      .map((section) => ({
        ...section,
        data: section.data.filter((credit) => credit.name.toLowerCase().includes(term)),
      }))
      .filter((section) => section.data.length);
  }, [all, query]);
  const count = all.reduce((sum, section) => sum + section.data.length, 0);
  return (
    <View style={{ flex: 1, backgroundColor: tokens.bg }}>
      <Stack.Screen options={{ title: "Open-source credits" }} />
      <SectionList
        sections={sections}
        keyExtractor={(credit, index) => `${credit.name}@${credit.version}:${index}`}
        renderItem={({ item }) => <Row credit={item} />}
        renderSectionHeader={({ section }) => (
          <Text
            accessibilityRole="header"
            style={{
              color: tokens.textMuted,
              backgroundColor: tokens.bg,
              fontSize: 13,
              paddingHorizontal: 20,
              paddingTop: 20,
              paddingBottom: 8,
            }}
          >
            {section.title}
          </Text>
        )}
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={
          <View style={{ padding: 20, gap: 16 }}>
            <Text style={{ color: tokens.text, fontSize: 15, lineHeight: 22 }}>
              Shellbell is built on {count} open-source projects. Thank you to everyone who
              maintains them. Tap one to read its licence.
            </Text>
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder="Search"
              placeholderTextColor={tokens.textFaint}
              autoCorrect={false}
              autoCapitalize="none"
              accessibilityLabel="Search open-source credits"
              style={{
                color: tokens.text,
                backgroundColor: tokens.surface,
                borderRadius: 10,
                paddingHorizontal: 12,
                minHeight: 44,
                fontSize: 15,
              }}
            />
          </View>
        }
        stickySectionHeadersEnabled={false}
      />
    </View>
  );
}
