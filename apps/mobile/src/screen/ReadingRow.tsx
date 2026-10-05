import { codePoints } from "@shellbell/protocol";
import { useMemo } from "react";
import { ScrollView, Text, View } from "react-native";
import { FONT, tokens } from "../theme/tokens";
import { safeText } from "./display-text";
import { LineView, runStyle } from "./LineView";
import type { ReadingDisplayRow } from "./reading-presentation";

export function ReadingRow({
  paragraph,
  fontSize,
  paneWidth,
}: {
  paragraph: Extract<ReadingDisplayRow, { kind: "paragraph" }>;
  fontSize: number;
  paneWidth: number;
}) {
  const line = useMemo(
    () => ({ r: paragraph.runs.map((run) => ({ ...run, t: safeText(run.t) })) }),
    [paragraph.runs],
  );
  if (paragraph.overflow) {
    const cells = paragraph.runs.reduce((n, run) => n + (run.n ?? codePoints(run.t)), 0);
    return (
      <View style={{ width: paneWidth }}>
        <Text style={{ color: tokens.textMuted, fontSize: 12 }}>Long row — scroll sideways</Text>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator
          bounces={false}
          contentContainerStyle={{ width: Math.max(paneWidth, cells * fontSize * 0.6) }}
        >
          <LineView line={line} fontSize={fontSize} />
        </ScrollView>
      </View>
    );
  }
  let offset = 0;
  return (
    <Text
      allowFontScaling={false}
      style={{
        width: paneWidth,
        fontFamily: FONT.regular,
        color: tokens.text,
        fontSize,
        lineHeight: fontSize * 1.4,
      }}
    >
      {paragraph.runs.length === 0
        ? " "
        : line.r.map((run) => {
            // Ordered text offsets identify these stateless spans; empty runs get a
            // distinct slot without changing their source text or style.
            const key = offset;
            offset += Math.max(1, run.t.length);
            return (
              <Text key={key} allowFontScaling={false} style={runStyle(run, fontSize)}>
                {run.t}
              </Text>
            );
          })}
    </Text>
  );
}
