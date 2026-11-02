import type { BackendDescriptor, SessionInfoLoose } from "@shellbell/protocol";
import { Pressable, Text, View } from "react-native";
import { useCloseWhenHidden } from "../security/screen-hidden";
import { tokens } from "../theme/tokens";
import { sessionTitle } from "../util/session-label";
import { sessionDetails } from "../util/session-types";
import { Sheet } from "./Sheet";

/** Everything the list knows about one session, from the (i) at the end of its row. */
export function SessionDetailsSheet({
  session,
  catalog,
  onClose,
}: {
  session: SessionInfoLoose | null;
  catalog?: readonly BackendDescriptor[];
  onClose: () => void;
}) {
  const hidden = useCloseWhenHidden(session !== null, onClose);
  return (
    <Sheet
      visible={session !== null && !hidden}
      onClose={onClose}
      dismissLabel="Close session details"
      accessibilityLabel="Session details"
    >
      {session ? (
        <View style={{ gap: 12 }}>
          <Text
            accessibilityRole="header"
            numberOfLines={1}
            style={{ color: tokens.text, fontSize: 20, fontWeight: "600" }}
          >
            {sessionTitle(session)}
          </Text>
          {sessionDetails(session, catalog).map((line) => (
            <View key={line.label} accessible style={{ gap: 2 }}>
              <Text style={{ color: tokens.textMuted, fontSize: 13 }}>{line.label}</Text>
              <Text selectable style={{ color: tokens.text, fontSize: 15 }}>
                {line.value}
              </Text>
            </View>
          ))}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Done"
            onPress={onClose}
            style={{ minHeight: 48, alignItems: "center", justifyContent: "center" }}
          >
            <Text style={{ color: tokens.text, fontSize: 15 }}>Done</Text>
          </Pressable>
        </View>
      ) : null}
    </Sheet>
  );
}

/** The filter row: one type at a time, with All to clear. */
export function SessionFilterRow({
  options,
  filter,
  onChange,
}: {
  options: readonly { kind: string; value: string; label: string }[];
  filter: { kind: string; value: string } | null;
  onChange: (next: { kind: string; value: string; label: string } | null) => void;
}) {
  const chip = (key: string, label: string, selected: boolean, onPress: () => void) => (
    <Pressable
      key={key}
      accessibilityRole="button"
      accessibilityLabel={label === "All" ? "Show all sessions" : `Show only ${label}`}
      accessibilityState={{ selected }}
      onPress={onPress}
      style={{
        minHeight: 32,
        paddingHorizontal: 12,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: selected ? tokens.text : tokens.border,
        backgroundColor: selected ? tokens.surface2 : "transparent",
        justifyContent: "center",
      }}
    >
      <Text style={{ color: selected ? tokens.text : tokens.textMuted, fontSize: 13 }}>
        {label}
      </Text>
    </Pressable>
  );
  return (
    <View
      testID="session-filter"
      style={{
        flexDirection: "row",
        flexWrap: "wrap",
        gap: 6,
        paddingHorizontal: 12,
        paddingTop: 8,
      }}
    >
      {chip("all", "All", filter === null, () => onChange(null))}
      {options.map((option) =>
        chip(
          `${option.kind}:${option.value}`,
          option.label,
          filter?.kind === option.kind && filter.value === option.value,
          () => onChange(option),
        ),
      )}
    </View>
  );
}
