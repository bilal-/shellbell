export interface NetworkReading {
  type?: string;
  isConnected?: boolean;
  isInternetReachable?: boolean;
}

export interface NetworkSnapshot {
  type: string | null;
  internet: "online" | "offline" | "unknown";
  /** No network interface; an unvalidated LAN may still reach a private relay. */
  disconnected: boolean;
}

export const UNKNOWN_NETWORK: NetworkSnapshot = {
  type: null,
  internet: "unknown",
  disconnected: false,
};

export interface NetworkSource {
  current(): NetworkSnapshot;
  subscribe(listener: (snapshot: NetworkSnapshot) => void): () => void;
}

export function networkSnapshot(reading: NetworkReading): NetworkSnapshot {
  const type = reading.type ?? null;
  const disconnected =
    type === "NONE" || ((!type || type === "UNKNOWN") && reading.isConnected === false);
  const offline =
    disconnected || reading.isConnected === false || reading.isInternetReachable === false;
  return {
    type,
    disconnected,
    internet: offline ? "offline" : reading.isInternetReachable === true ? "online" : "unknown",
  };
}

export function networkPathChanged(before: NetworkSnapshot, after: NetworkSnapshot): boolean {
  const known = (type: string | null) => type !== null && type !== "NONE" && type !== "UNKNOWN";
  return known(before.type) && known(after.type) && before.type !== after.type;
}

interface MonitorPorts {
  read(): Promise<NetworkReading>;
  subscribe(refresh: () => void): () => void;
  active(): boolean;
  subscribeActivity(refresh: () => void): () => void;
}

/** Native events trigger a fresh reading: deferred disconnect events can describe an old path. */
export function monitorNetwork(
  ports: MonitorPorts,
  publish: (snapshot: NetworkSnapshot) => void,
): () => void {
  let stopped = false;
  let revision = 0;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let confirmations: ReturnType<typeof setTimeout>[] = [];
  const clearConfirmations = () => {
    for (const timer of confirmations) clearTimeout(timer);
    confirmations = [];
  };
  const current = (owner: number) => !stopped && ports.active() && owner === revision;
  const refresh = () => {
    clearTimeout(retry);
    retry = undefined;
    const owner = ++revision;
    if (stopped || !ports.active()) return;
    const recheck = () => {
      if (current(owner)) retry = setTimeout(refresh, 5_000);
    };
    void ports.read().then((reading) => {
      if (!current(owner)) return;
      const snapshot = networkSnapshot(reading);
      publish(snapshot);
      // Reconcile missed callbacks while offline, and refresh again on every foreground.
      if (snapshot.internet !== "online") recheck();
    }, recheck);
  };
  const changed = () => {
    clearConfirmations();
    refresh();
    // Android can return the just-lost default network even after onLost.
    // Confirm the transition even when that first reading still says online.
    if (!stopped && ports.active())
      confirmations = [500, 2_000, 5_000].map((delay) => setTimeout(refresh, delay));
  };
  const offNetwork = ports.subscribe(changed);
  const offActivity = ports.subscribeActivity(changed);
  refresh();
  return () => {
    stopped = true;
    revision += 1;
    clearTimeout(retry);
    clearConfirmations();
    offNetwork();
    offActivity();
  };
}
