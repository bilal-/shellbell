import { Dimensions, Keyboard, Platform } from "react-native";
import { useUiStore } from "../store/computers";
import { initialTerminalSizer } from "./initial-size";

/** Read at creation time, after the menu opens, so rotation and font changes are current. */
export function newSessionSize(insets: {
  left?: number;
  right?: number;
  top?: number;
  bottom?: number;
}) {
  return initialTerminalSizer.forWindow(
    Dimensions.get("window"),
    useUiStore.getState().fontSize,
    insets,
    Platform.OS === "android" && Keyboard.isVisible(),
  );
}
