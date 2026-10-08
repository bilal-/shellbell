import { vi } from "vitest";

// Native symbol rendering is exercised on a simulator; component tests retain
// its props and accessibility structure without loading a native view manager.
vi.mock("expo-symbols", () => ({ SymbolView: "SymbolView" }));
