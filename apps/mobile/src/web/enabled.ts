import { Platform } from "react-native";
import { nativeWebDoor } from "./native-door";

/** Apps require a native loopback transport in the installed mobile binary. */
export const PAGES_ENABLED =
  (Platform.OS === "android" || Platform.OS === "ios") && nativeWebDoor !== null;
