import { useKeepAwake } from "expo-keep-awake";
import { Stack, useLocalSearchParams } from "expo-router";
import { useHeaderHeight } from "expo-router/react-navigation";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { KeyboardAvoidingView, useKeyboardState } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { InputBar } from "../../src/input/InputBar";
import type { MobileStreamSnapshot } from "../../src/net/mobile-screen-stream";
import { ScreenView } from "../../src/screen/ScreenView";
import { useUiStore } from "../../src/store/computers";
import { tokens } from "../../src/theme/tokens";
import { cjkLines, htopScreen, llmStatusScreen, logLines } from "../../src/util/fixtures";

const SETS = {
  htop: htopScreen(),
  cjk: cjkLines(),
  log: logLines(1000),
  status: llmStatusScreen(),
};
// Not a valid fingerprint: InputBar cannot resolve a real connection for this fixture.
const FIXTURE = "offline-renderer-fixture";

export default function RenderSpike() {
  useKeepAwake();
  const { fixture } = useLocalSearchParams<{ fixture?: string }>();
  const headerHeight = useHeaderHeight();
  const insets = useSafeAreaInsets();
  const keyboardVisible = useKeyboardState((state) => state.isVisible);
  const [availableHeight, setAvailableHeight] = useState<number | null>(null);
  const [which, setWhich] = useState<keyof typeof SETS>(fixture === "status" ? "status" : "log");
  const [tick, setTick] = useState(0);
  const [reading, setReading] = useState(false);
  const [renderer, setRenderer] = useState<"webgl" | "dom" | null>(null);
  const fit = useUiStore((s) => s.fitWidth);
  const setFit = useUiStore((s) => s.setFitWidth);
  const stream = useMemo<MobileStreamSnapshot>(() => {
    const lines = SETS[which];
    const history = which === "log" ? lines.slice(0, -30) : [];
    const live = which === "log" ? lines.slice(-30) : lines;
    return {
      status: "live",
      historyStatus: "end",
      screen: {
        cols: which === "htop" ? 160 : 80,
        rows: live.length,
        lines: live.map((line, i) =>
          i === live.length - 1 && tick
            ? { r: [{ t: `local redraw ${tick} · no remote input` }] }
            : line,
        ),
        cursor: { x: 0, y: which === "status" ? 8 : live.length - 1 },
        scrollbackTotal: history.length,
        gen: tick + 1,
      },
      history: {
        anchor: { subscriptionId: FIXTURE, generation: 1, before: history.length },
        nextBefore: 0,
        readOnly: false,
        gaps: [],
        encodedBytes: 0,
        rows: history.map((line, row) => ({ key: `fixture:${row}`, row, line })),
      },
    };
  }, [which, tick]);
  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior="padding"
      keyboardVerticalOffset={headerHeight}
    >
      <Stack.Screen options={{ title: "Offline terminal QA" }} />
      <View
        style={{
          flex: 1,
          backgroundColor: tokens.bg,
          paddingLeft: insets.left,
          paddingRight: insets.right,
        }}
        onLayout={({ nativeEvent }) => setAvailableHeight(nativeEvent.layout.height)}
      >
        {!keyboardVisible ? (
          <>
            <Text style={{ color: tokens.textMuted, padding: 8 }}>
              Synthetic data. Input is never sent to a computer. Renderer: {renderer ?? "loading"}.
            </Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, padding: 8 }}>
              {(Object.keys(SETS) as (keyof typeof SETS)[]).map((k) => (
                <Pressable
                  key={k}
                  onPress={() => setWhich(k)}
                  style={{
                    padding: 8,
                    backgroundColor: which === k ? tokens.accents.emerald : tokens.surface2,
                    borderRadius: tokens.radius.sm,
                  }}
                >
                  <Text style={{ color: tokens.text }}>{k}</Text>
                </Pressable>
              ))}
              <Pressable
                onPress={() => setTick((t) => t + 1)}
                style={{
                  padding: 8,
                  backgroundColor: tokens.surface2,
                  borderRadius: tokens.radius.sm,
                }}
              >
                <Text style={{ color: tokens.text }}>redraw</Text>
              </Pressable>
              <Pressable onPress={() => setReading((v) => !v)} style={{ padding: 8 }}>
                <Text style={{ color: tokens.text }}>{reading ? "Terminal" : "Read"}</Text>
              </Pressable>
              <Pressable onPress={() => setFit(!fit)} style={{ padding: 8 }}>
                <Text style={{ color: tokens.text }}>{fit ? "Actual size" : "Fit"}</Text>
              </Pressable>
            </View>
          </>
        ) : null}
        <ScreenView
          onRenderer={setRenderer}
          stream={stream}
          accent={tokens.accents.emerald}
          blinking={false}
          inferredCursor={false}
          readingMode={reading}
          onLoadOlder={() => {}}
        />
        <InputBar
          fp={FIXTURE}
          sessionId={FIXTURE}
          accent={tokens.accents.emerald}
          showChips={false}
          availableHeight={availableHeight}
        />
      </View>
    </KeyboardAvoidingView>
  );
}
