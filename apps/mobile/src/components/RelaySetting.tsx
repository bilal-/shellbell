import { useEffect, useState } from "react";
import { Pressable, Switch, Text, TextInput, View } from "react-native";
import { useComputersStore } from "../store/computers";
import { tokens } from "../theme/tokens";
import { parseRelaySetting } from "../util/relay-url";

export function RelaySetting({ fp, relayUrl }: { fp: string; relayUrl: string }) {
  const [draft, setDraft] = useState(relayUrl);
  const [insecure, setInsecure] = useState(relayUrl.startsWith("ws://"));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setDraft(relayUrl);
    setInsecure(relayUrl.startsWith("ws://"));
    setError(null);
  }, [relayUrl]);
  return (
    <View style={{ gap: 10 }}>
      <Text style={{ color: tokens.textMuted, fontSize: 12, letterSpacing: 1 }}>RELAY URL</Text>
      <TextInput
        accessibilityLabel="Relay URL"
        value={draft}
        onChangeText={setDraft}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        placeholder="wss://relay.example.com"
        placeholderTextColor={tokens.textFaint}
        style={{
          color: tokens.text,
          borderColor: tokens.border,
          borderWidth: 1,
          borderRadius: tokens.radius.md,
          padding: 12,
        }}
      />
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        <Text style={{ flex: 1, color: tokens.textMuted, fontSize: 13 }}>
          Allow unencrypted WebSocket for local testing
        </Text>
        <Switch
          accessibilityLabel="Allow unencrypted WebSocket for local testing"
          value={insecure}
          onValueChange={setInsecure}
        />
      </View>
      <Text style={{ color: tokens.textFaint, fontSize: 12 }}>
        Use the same relay as this computer. Saving reconnects this phone. A new relay may require
        pairing again.
      </Text>
      {error ? (
        <Text accessibilityRole="alert" style={{ color: tokens.accents.rose }}>
          {error}
        </Text>
      ) : null}
      <Pressable
        accessibilityRole="button"
        disabled={draft === relayUrl}
        onPress={() => {
          try {
            const next = parseRelaySetting(draft, insecure);
            const store = useComputersStore.getState();
            if (!store.computers.some((c) => c.fp === fp && !c.removing)) return;
            store.update(fp, { relayUrl: next });
            setDraft(next);
            setError(null);
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : "Could not save relay URL.");
          }
        }}
        style={{
          backgroundColor: tokens.surface2,
          borderRadius: tokens.radius.md,
          padding: 12,
          alignItems: "center",
        }}
      >
        <Text style={{ color: draft === relayUrl ? tokens.textFaint : tokens.text }}>
          Save relay URL
        </Text>
      </Pressable>
    </View>
  );
}
