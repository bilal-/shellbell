import * as Network from "expo-network";
import { AppState } from "react-native";
import { useNetworkStore } from "../store/network";
import { monitorNetwork } from "./network-monitor";

export function startNetworkMonitor(): () => void {
  return monitorNetwork(
    {
      read: () => Network.getNetworkStateAsync(),
      subscribe: (refresh) => {
        const subscription = Network.addNetworkStateListener(refresh);
        return () => subscription.remove();
      },
      active: () => AppState.currentState === "active",
      subscribeActivity: (refresh) => {
        const subscription = AppState.addEventListener("change", refresh);
        return () => subscription.remove();
      },
    },
    (snapshot) => useNetworkStore.getState().update(snapshot),
  );
}
