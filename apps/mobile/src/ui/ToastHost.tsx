import { useCallback } from "react";
import { StyleSheet, View } from "react-native";
import { useConnectionsStore } from "../store/connections";
import { Toast } from "./Toast";

/**
 * Renders whichever computer currently has a toast (spec 12 lost-input, spec 10.8 foreground
 * rings). Mounted at the root so a ring that arrives while the user is on the computers or
 * sessions list is visible immediately instead of surfacing later on a session screen.
 */
export function ToastHost() {
  const fp = useConnectionsStore(
    (s) => Object.keys(s.byComputer).find((k) => s.byComputer[k]?.toast !== undefined) ?? null,
  );
  const text = useConnectionsStore((s) => (fp === null ? null : (s.byComputer[fp]?.toast ?? null)));
  const onDone = useCallback(() => {
    if (fp === null) return;
    useConnectionsStore.getState().patch(fp, () => ({ toast: undefined }));
  }, [fp]);

  if (fp === null || text === null) return null;
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <Toast text={text} onDone={onDone} />
    </View>
  );
}
