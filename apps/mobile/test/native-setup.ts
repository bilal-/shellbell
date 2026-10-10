import { vi } from "vitest";

// Native symbol rendering is exercised on a simulator; component tests retain
// its props and accessibility structure without loading a native view manager.
vi.mock("expo-symbols", () => ({ SymbolView: "SymbolView" }));

// A phone without a passcode: App Lock stays out of the way unless a test opts in.
vi.mock("expo-local-authentication", () => ({
  SecurityLevel: { NONE: 0, SECRET: 1, BIOMETRIC_WEAK: 2, BIOMETRIC_STRONG: 3 },
  AuthenticationType: { FINGERPRINT: 1, FACIAL_RECOGNITION: 2, IRIS: 3 },
  getEnrolledLevelAsync: vi.fn(async () => 0),
  supportedAuthenticationTypesAsync: vi.fn(async () => []),
  authenticateAsync: vi.fn(async () => ({ success: false, error: "not_enrolled" })),
}));
