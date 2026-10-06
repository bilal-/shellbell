import { useEffect, useState } from "react";
import { AccessibilityInfo } from "react-native";

export function useScreenReader(): boolean {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    let active = true;
    let changed = false;
    const subscription = AccessibilityInfo?.addEventListener("screenReaderChanged", (value) => {
      changed = true;
      setEnabled(value);
    });
    void AccessibilityInfo?.isScreenReaderEnabled()
      .then((value) => {
        if (active && !changed) setEnabled(value);
      })
      .catch(() => {});
    return () => {
      active = false;
      subscription?.remove();
    };
  }, []);
  return enabled;
}
