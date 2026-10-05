import { Stack } from "expo-router";
import { ScrollView, Text } from "react-native";
import { terminalLicenses } from "../src/terminal/gen/document";
import { tokens } from "../src/theme/tokens";

export default function Licenses() {
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: tokens.bg }}
      contentContainerStyle={{ padding: 20 }}
    >
      <Stack.Screen options={{ title: "Open-source credits" }} />
      <Text selectable style={{ color: tokens.text, fontSize: 15, lineHeight: 22 }}>
        Shellbell's terminal view is powered by xterm.js and its contributors. Thank you to the
        upstream maintainers.{"\n\n"}
        {terminalLicenses}
      </Text>
    </ScrollView>
  );
}
