import { act, createElement } from "react";
import { createRoot } from "test-renderer";
import { expect, it, vi } from "vitest";

const platform = vi.hoisted(() => ({ OS: "android" }));
vi.mock("react-native", () => ({
  Platform: platform,
  Pressable: "Pressable",
  SectionList: "SectionList",
  Text: "Text",
  TextInput: "TextInput",
  View: "View",
}));
vi.mock("expo-router", () => ({ Stack: { Screen: () => null } }));

const credits = (await import("../src/credits/gen/credits.json")).default;

it("credits what ships, with a licence text for every library", () => {
  const names = credits.sections.flatMap((section) => section.items.map((item) => item.name));
  for (const name of ["react-native", "react-native-webrtc", "expo-camera", "zod"])
    expect(names).toContain(name);
  // Build tools never ship, so they aren't credited.
  expect(names).not.toContain("metro");
  expect(names).not.toContain("typescript");
  for (const section of credits.sections)
    for (const item of section.items) expect(credits.texts[item.text]?.length).toBeGreaterThan(100);
});

it("lists this platform's libraries and finds them by name", async () => {
  const { default: Licenses } = await import("../app/licenses");
  const root = createRoot();
  await act(async () => root.render(createElement(Licenses)));
  const list = () => root.container.queryAll((n) => n.type === "SectionList")[0]!;
  const titles = () => list().props.sections.map((s: { title: string }) => s.title);
  expect(titles()).toEqual(["Terminal", "JavaScript libraries", "Android libraries"]);
  // The search box sits in the list's header.
  const search = list().props.ListHeaderComponent.props.children[1];
  await act(async () => search.props.onChangeText("webrtc"));
  const found = list().props.sections.flatMap((s: { data: { name: string }[] }) =>
    s.data.map((item) => item.name),
  );
  expect(found).toEqual(["react-native-webrtc", "WebRTC (org.jitsi)"]);
  await act(async () => root.unmount());
});
