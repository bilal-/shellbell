import { Platform } from "react-native";

/** Android has the native loopback door; iOS keeps opening links in the browser. */
export const PAGES_ENABLED = Platform.OS === "android";
