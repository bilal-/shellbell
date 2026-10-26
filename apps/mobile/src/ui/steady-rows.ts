import { useCallback, useMemo, useRef, useState } from "react";
import type { GestureResponderEvent } from "react-native";
import { holdRows, tapLanded } from "../util/steady-rows";

/**
 * Rows that stand still while a finger is on the list, and a check that a tap was aimed at the
 * rows it landed on. Spread `touch` on a view around the list; call `landed()` in each row's
 * `onPress` before acting.
 */
export function useSteadyRows<T>(rows: readonly T[], key: (row: T) => string) {
  const held = useRef<readonly T[] | null>(null);
  const shownRef = useRef<readonly T[]>(rows);
  const order = useRef<string | null>(null);
  const movedAt = useRef(0);
  // Judged when the finger comes down: letting go may reorder the rows before `onPress` runs.
  const settled = useRef(true);
  const [, released] = useState(0);

  const shown = held.current ? holdRows(held.current, rows, key) : rows;
  if (held.current) held.current = shown;
  shownRef.current = shown;
  const nextOrder = shown.map(key).join("\n");
  if (order.current !== null && order.current !== nextOrder) movedAt.current = Date.now();
  order.current = nextOrder;

  const touch = useMemo(() => {
    const release = (event: GestureResponderEvent) => {
      if (event.nativeEvent.touches.length > 0 || !held.current) return;
      held.current = null;
      released((n) => n + 1);
    };
    return {
      onTouchStart: () => {
        if (held.current) return;
        settled.current = tapLanded(Date.now(), movedAt.current);
        held.current = shownRef.current;
      },
      onTouchEnd: release,
      onTouchCancel: release,
    };
  }, []);
  const landed = useCallback(() => settled.current, []);
  return { rows: shown, touch, landed };
}
