import { type Href, useRouter } from "expo-router";
import { HeaderButton } from "./HeaderButton";

export function SettingsButton({
  href = "/settings",
  label = "Settings",
}: {
  href?: Href;
  label?: string;
}) {
  const router = useRouter();
  return <HeaderButton icon="settings" label={label} onPress={() => router.push(href)} />;
}
