import { requireOptionalNativeModule } from "expo-modules-core";
import { useSyncExternalStore } from "react";
import { HardwareKeyboardMonitor, type KeyboardAttachmentSource } from "./hardware-keyboard";

const monitor = new HardwareKeyboardMonitor(
  requireOptionalNativeModule<KeyboardAttachmentSource>("ShellbellTerminalInput"),
);
export function useHardwareKeyboard(): boolean {
  return useSyncExternalStore(monitor.subscribe, monitor.getSnapshot, monitor.getSnapshot);
}
