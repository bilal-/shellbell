import { expect, it, vi } from "vitest";
import { initialTerminalSizer } from "../src/terminal/initial-size";
import { newSessionSize } from "../src/terminal/new-session-size";

const native = vi.hoisted(() => ({
  width: 390,
  height: 844,
  keyboard: false,
  fontSize: 12,
  platform: "android",
}));
vi.mock("react-native", () => ({
  Dimensions: { get: () => ({ width: native.width, height: native.height }) },
  Keyboard: { isVisible: () => native.keyboard },
  Platform: {
    get OS() {
      return native.platform;
    },
  },
}));
vi.mock("../src/store/computers", () => ({
  useUiStore: { getState: () => ({ fontSize: native.fontSize }) },
}));

it("reads current keyboard, app window and font when creating a terminal", () => {
  initialTerminalSizer.remember({ cols: 54, rows: 38, width: 390, height: 610, fontSize: 12 }, 844);
  expect(newSessionSize({})).toEqual({ cols: 54, rows: 38 });
  native.height = 700;
  expect(newSessionSize({})).toEqual({ cols: 54, rows: 31 });
  native.height = 400;
  native.keyboard = true;
  expect(newSessionSize({})).toEqual({ cols: 54, rows: 38 });
  native.keyboard = false;
  expect(newSessionSize({})).toEqual({ cols: 54, rows: 24 });
  native.height = 844;
  native.fontSize = 18;
  expect(newSessionSize({})).toEqual({ cols: 40, rows: 27 });
  // iOS overlays its keyboard; it must not excuse a genuinely resized window.
  native.platform = "ios";
  native.height = 700;
  native.fontSize = 12;
  native.keyboard = true;
  expect(newSessionSize({})).toEqual({ cols: 54, rows: 31 });
});
