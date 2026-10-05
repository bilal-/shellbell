import { Stack, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { Button, ScrollView, Text, View } from "react-native";
import { connectionManager } from "../../src/net/manager";
import { qualifyTransport } from "../../src/net/transport-qualification";
import { useComputersStore } from "../../src/store/computers";
import { useNetworkStore } from "../../src/store/network";

/** Explicit owner-build diagnostics. Counters contain encrypted frame sizes only. */
export default function TransportDiagnostics() {
  const computers = useComputersStore((state) => state.computers);
  const network = useNetworkStore((state) => state.snapshot);
  const [, refresh] = useState(0);
  const [qualification, setQualification] = useState("");
  const { run } = useLocalSearchParams<{ run?: string }>();
  const [running, setRunning] = useState(false);
  const firstFp = computers[0]?.fp;
  useEffect(() => {
    if (
      (run !== "fixture" && run !== "handoff" && run !== "offline") ||
      !firstFp ||
      process.env.EXPO_PUBLIC_SHELLBELL_DIRECT !== "1"
    )
      return;
    const controller = new AbortController();
    setRunning(true);
    void qualifyTransport(
      firstFp,
      controller.signal,
      (stage) => {
        setQualification(stage);
        console.info("SHELLBELL_QUALIFICATION", stage);
      },
      run === "handoff" ? "handoff" : run === "offline" ? "offline" : "recovery",
    )
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : "Qualification failed";
        setQualification(message);
        console.info("SHELLBELL_QUALIFICATION_FAILURE", message);
      })
      .finally(() => setRunning(false));
    return () => controller.abort();
  }, [run, firstFp]);
  useEffect(() => {
    const timer = setInterval(() => refresh((value) => value + 1), 500);
    return () => clearInterval(timer);
  }, []);
  if (process.env.EXPO_PUBLIC_SHELLBELL_DIRECT !== "1")
    return (
      <Text style={{ color: "#fff" }}>Transport diagnostics require an owner test build.</Text>
    );
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: "#111" }}
      contentContainerStyle={{ padding: 24, gap: 20 }}
    >
      <Stack.Screen options={{ title: "Transport diagnostics" }} />
      <Text style={{ color: "#fff" }}>{qualification}</Text>
      <Text style={{ color: "#fff" }}>
        Network: {network.type ?? "unknown"} · {network.internet}
      </Text>
      {running ? <Text style={{ color: "#fff" }}>Disposable fixture is running…</Text> : null}
      {computers.map((computer) => {
        const connection = connectionManager.get(computer.fp);
        const diagnostics = connection?.transportDiagnostics;
        return (
          <View key={computer.fp} style={{ gap: 12 }}>
            <Text style={{ fontSize: 20, color: "#fff" }}>
              {computer.name}: {diagnostics?.route ?? "uncommitted"} ·{" "}
              {connection?.status ?? "idle"}
            </Text>
            <Text selectable style={{ color: "#fff" }}>
              {JSON.stringify(diagnostics, null, 2)}
            </Text>
            <Button title="Pause relay" onPress={() => connection?.testTransport("pause-relay")} />
            <Button
              title="Resume relay"
              onPress={() => connection?.testTransport("resume-relay")}
            />
            <Button
              title="Drop direct and use relay"
              onPress={() => connection?.testTransport("drop-direct")}
            />
          </View>
        );
      })}
    </ScrollView>
  );
}
