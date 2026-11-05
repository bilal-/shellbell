import { classifyWebLink, WEB_FEATURE } from "@shellbell/protocol";
import { router } from "expo-router";
import { Alert, Platform } from "react-native";
import { useComputersStore } from "../store/computers";
import { useConnectionsStore } from "../store/connections";

/** Pages ship on Android first; iOS keeps opening every link in the browser until it follows. */
export const PAGES_ENABLED = Platform.OS === "android";

export { LocalLinkContext, type LocalLinkHandler } from "./link-context";

export function computerName(fp: string): string {
  return (
    useConnectionsStore.getState().byComputer[fp]?.hello?.computerName ??
    useComputersStore.getState().computers.find((c) => c.fp === fp)?.name ??
    "your computer"
  );
}

/** Opens the page screen for a local address after the person chooses Open. */
export function openLocalLink(fp: string, url: string, onCancel?: () => void): boolean {
  if (!PAGES_ENABLED) return false;
  const link = classifyWebLink(url);
  const name = computerName(fp);
  if (link.kind === "secure-local") {
    Alert.alert("Can't open this here", "Shellbell can't open secure local addresses yet.");
    return true;
  }
  if (link.kind !== "local") return false;
  const features = useConnectionsStore.getState().byComputer[fp]?.hello?.features ?? [];
  if (!features.includes(WEB_FEATURE)) {
    Alert.alert("Update Shellbell", `Update Shellbell on ${name} to open this here.`);
    return true;
  }
  // Nothing an agent writes opens without the owner choosing it, every time.
  Alert.alert(`Open ${link.origin.authority} from ${name}?`, url, [
    { text: "Cancel", style: "cancel", onPress: onCancel },
    {
      text: "Open",
      onPress: () =>
        router.push({
          pathname: "/c/[fp]/page",
          params: { fp, origin: link.origin.origin, path: link.path },
        }),
    },
  ]);
  return true;
}
