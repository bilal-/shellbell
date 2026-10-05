import { act, createElement } from "react";
import { createRoot } from "test-renderer";
import { describe, expect, it, vi } from "vitest";
import type { ReadingDisplayRow } from "../src/screen/reading-presentation";

vi.mock("react-native", () => ({ View: "View", Text: "Text", ScrollView: "ScrollView" }));
vi.mock("react-native-reanimated", () => ({ default: { View: "CursorView" } }));

import { ReadingRow } from "../src/screen/ReadingRow";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
const paragraph: Extract<ReadingDisplayRow, { kind: "paragraph" }> = {
  kind: "paragraph",
  key: "h:1",
  sourceKeys: ["h:1"],
  historyKey: "h:1",
  overflow: false,
  runs: [
    { t: "hello ", fg: [12, 34, 56], b: true },
    { t: "界 e\u0301 👩‍💻", bg: [17, 34, 51], i: true, u: true },
  ],
};

describe("actual ReadingRow", () => {
  it("shows iTerm blank-cell placeholders as spaces between words", async () => {
    const root = createRoot();
    try {
      await act(async () =>
        root.render(
          createElement(ReadingRow, {
            paragraph: { ...paragraph, runs: [{ t: "words\u0000stay\u0000apart" }] },
            fontSize: 12,
            paneWidth: 344,
          }),
        ),
      );
      expect(
        root.container
          .queryAll((n) => n.type === "Text")
          .flatMap((n) => n.children)
          .filter((c) => typeof c === "string"),
      ).toContain("words stay apart");
    } finally {
      await act(async () => root.unmount());
    }
  });
  it("renders styled Unicode as uncapped, pane-constrained prose without a cursor", async () => {
    const root = createRoot();
    try {
      await act(async () =>
        root.render(createElement(ReadingRow, { paragraph, fontSize: 12, paneWidth: 344 })),
      );
      const text = root.container.queryAll((n) => n.type === "Text");
      expect(text).toHaveLength(3);
      expect(text.every((n) => n.props.numberOfLines === undefined)).toBe(true);
      expect(text[0]!.props.style.width).toBe(344);
      expect(text[1]!.props.children).toBe("hello ");
      expect(text[1]!.props.style).toMatchObject({
        color: "#0c2238",
        fontFamily: "JetBrainsMonoNF-Bold",
      });
      expect(text[2]!.props.children).toBe("界 e\u0301 👩‍💻");
      expect(text[2]!.props.style).toMatchObject({
        backgroundColor: "#112233",
        textDecorationLine: "underline",
        fontFamily: "JetBrainsMonoNF-Italic",
      });
      expect(root.container.queryAll((n) => n.type === "CursorView")).toHaveLength(0);
      expect(root.container.queryAll((n) => n.type === "ScrollView")).toHaveLength(0);
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("keeps an empty source row visible without a terminal cursor", async () => {
    const root = createRoot();
    try {
      await act(async () =>
        root.render(
          createElement(ReadingRow, {
            paragraph: { ...paragraph, runs: [] },
            fontSize: 12,
            paneWidth: 200,
          }),
        ),
      );
      const text = root.container.queryAll((n) => n.type === "Text")[0]!;
      expect(text.props.children).toBe(" ");
      expect(text.props.style.lineHeight).toBeGreaterThanOrEqual(15);
      expect(root.container.queryAll((n) => n.type === "CursorView")).toHaveLength(0);
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("keeps oversized source text accessible in a labelled horizontal faithful row", async () => {
    const root = createRoot();
    const content = "x".repeat(100);
    try {
      await act(async () =>
        root.render(
          createElement(ReadingRow, {
            paragraph: { ...paragraph, overflow: true, runs: [{ t: content }] },
            fontSize: 12,
            paneWidth: 344,
          }),
        ),
      );
      const scroll = root.container.queryAll((n) => n.type === "ScrollView")[0]!;
      expect(scroll.props.horizontal).toBe(true);
      expect(scroll.props.showsHorizontalScrollIndicator).toBe(true);
      expect(scroll.props.contentContainerStyle.width).toBe(720);
      expect(
        root.container.queryAll(
          (n) => n.type === "Text" && n.props.children === "Long row — scroll sideways",
        ),
      ).toHaveLength(1);
      expect(
        root.container.queryAll((n) => n.type === "Text" && n.props.children === content),
      ).toHaveLength(1);
      expect(root.container.queryAll((n) => n.type === "CursorView")).toHaveLength(0);
    } finally {
      await act(async () => root.unmount());
    }
  });
});
