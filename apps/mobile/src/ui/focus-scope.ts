import { useFocusEffect } from "expo-router";
import { useCallback, useRef } from "react";

/**
 * A request started on a screen may finish after the person has left it, for example through a
 * notification. `start()` returns a check that stays true only while the screen keeps its focus,
 * so the reply can still be reported but never navigates away from where the person now is.
 */
export function useFocusScope(): { start(): () => boolean } {
  const epoch = useRef(0);
  useFocusEffect(
    useCallback(
      () => () => {
        epoch.current++;
      },
      [],
    ),
  );
  return useRef({
    start: () => {
      const started = epoch.current;
      return () => epoch.current === started;
    },
  }).current;
}
