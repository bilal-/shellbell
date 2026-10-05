import { codePoints, colorKey, colorToHex, type Line, type Run } from "@shellbell/protocol";
import { memo } from "react";
import { Text, View } from "react-native";
import { FONT, tokens } from "../theme/tokens";

/** Flip to true only if the on-device spike (Step 3) shows the nested-Text path dropping frames. */
export const ALWAYS_FIXED_WIDTH = false;

export function fontFor(r: Run): string {
  if (r.b && r.i) return FONT.boldItalic;
  if (r.b) return FONT.bold;
  if (r.i) return FONT.italic;
  return FONT.regular;
}

function decoration(r: Run) {
  if (r.u && r.s) return "underline line-through" as const;
  if (r.u) return "underline" as const;
  if (r.s) return "line-through" as const;
  return "none" as const;
}

export function runStyle(r: Run, fontSize: number) {
  return {
    fontFamily: fontFor(r),
    fontSize,
    color: colorToHex(r.fg, tokens.text, tokens.terminal16),
    backgroundColor:
      r.bg === undefined ? "transparent" : colorToHex(r.bg, "transparent", tokens.terminal16),
    textDecorationLine: decoration(r),
    opacity: r.f ? 0.6 : 1,
  };
}

/**
 * Keys are the run's starting cell offset plus its style signature: unique within the line, stable
 * across re-renders, and content-derived rather than an array index (Biome noArrayIndexKey).
 */
function keyedRuns(line: Line): { r: Run; key: string; cells: number }[] {
  let col = 0;
  return line.r.map((r) => {
    const cells = r.n ?? codePoints(r.t);
    const key = `${col}|${colorKey(r.fg)}|${colorKey(r.bg)}|${cells}`;
    col += cells;
    return { r, key, cells };
  });
}

export const LineView = memo(function LineView({
  line,
  fontSize,
}: {
  line: Line;
  fontSize: number;
}) {
  const lineHeight = fontSize * 1.25;
  const charWidth = fontSize * 0.6;
  if (line.r.length === 0) {
    return (
      <Text
        allowFontScaling={false}
        style={{ fontFamily: FONT.regular, fontSize, lineHeight, color: tokens.text }}
      >
        {" "}
      </Text>
    );
  }
  const runs = keyedRuns(line);
  const needsCells = ALWAYS_FIXED_WIDTH || line.r.some((r) => r.n !== undefined);
  if (!needsCells) {
    return (
      <Text
        numberOfLines={1}
        allowFontScaling={false}
        style={{ fontFamily: FONT.regular, fontSize, lineHeight, color: tokens.text }}
      >
        {runs.map(({ r, key }) => (
          <Text key={key} allowFontScaling={false} style={runStyle(r, fontSize)}>
            {r.t}
          </Text>
        ))}
      </Text>
    );
  }
  return (
    <View style={{ flexDirection: "row", height: lineHeight }}>
      {runs.map(({ r, key, cells }) => {
        const style = runStyle(r, fontSize);
        return (
          <View
            key={key}
            style={{
              width: cells * charWidth,
              overflow: "hidden",
              backgroundColor: style.backgroundColor,
            }}
          >
            <Text
              numberOfLines={1}
              allowFontScaling={false}
              style={{ ...style, backgroundColor: "transparent", lineHeight }}
            >
              {r.t}
            </Text>
          </View>
        );
      })}
    </View>
  );
});
