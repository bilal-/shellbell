import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useComputersStore } from "../../../src/store/computers";
import { tokens } from "../../../src/theme/tokens";
import { HeaderButton } from "../../../src/ui/HeaderButton";
import { SettingsButton } from "../../../src/ui/SettingsButton";

export default function ComputerLayout() {
  const { fp } = useLocalSearchParams<{ fp: string }>();
  const router = useRouter();
  const computer = useComputersStore((s) => s.computers.find((c) => c.fp === fp));
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: tokens.bg },
        headerTintColor: tokens.text,
        contentStyle: { backgroundColor: tokens.bg },
      }}
    >
      <Stack.Screen
        name="index"
        options={{
          title: computer?.name ?? "Computer",
          headerLeft: () => (
            <HeaderButton
              icon="left"
              label="Back to computers"
              onPress={() => router.dismissTo("/")}
            />
          ),
          headerRight: () => (
            <SettingsButton href={`/c/${fp}/settings`} label="Computer settings" />
          ),
        }}
      />
      <Stack.Screen name="settings" options={{ title: "Computer settings" }} />
      <Stack.Screen name="s/[sid]" />
    </Stack>
  );
}
