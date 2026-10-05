import { create } from "zustand";
import { type NetworkSnapshot, type NetworkSource, UNKNOWN_NETWORK } from "../net/network-monitor";

export const useNetworkStore = create<{
  snapshot: NetworkSnapshot;
  update(snapshot: NetworkSnapshot): void;
}>((set, get) => ({
  snapshot: UNKNOWN_NETWORK,
  update(snapshot) {
    const previous = get().snapshot;
    if (
      previous.type !== snapshot.type ||
      previous.internet !== snapshot.internet ||
      previous.disconnected !== snapshot.disconnected
    )
      set({ snapshot });
  },
}));

export const networkSource: NetworkSource = {
  current: () => useNetworkStore.getState().snapshot,
  subscribe: (listener) =>
    useNetworkStore.subscribe((state, before) => {
      if (state.snapshot !== before.snapshot) listener(state.snapshot);
    }),
};
