import { Text, View } from "react-native";
import { tokens } from "../theme/tokens";
import type { StateTone } from "../util/session-state";

const TONE_COLOR: Record<StateTone, string> = {
  muted: tokens.textFaint,
  active: tokens.accents.amber,
  alert: tokens.accents.rose,
};

type PillProps = { text: string } & (
  | { tone: StateTone; color?: undefined }
  | { color: string; tone?: undefined }
);

/** A small rounded label. Pass `tone` for the shared state vocabulary, or a raw `color`. */
export function Pill({ text, tone, color }: PillProps) {
  const c = tone ? TONE_COLOR[tone] : color;
  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: c,
        borderRadius: 999,
        paddingHorizontal: 8,
        paddingVertical: 2,
      }}
    >
      <Text style={{ color: c, fontSize: 12 }}>{text}</Text>
    </View>
  );
}
