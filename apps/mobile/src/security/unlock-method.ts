import * as LocalAuthentication from "expo-local-authentication";
import { Platform } from "react-native";
import type { AppIconName } from "../ui/AppIcon";

export interface UnlockMethod {
  /** False when the phone has no passcode or screen lock, so there is nothing to ask for. */
  available: boolean;
  /** Reads after "Unlock with": "Face ID", "fingerprint", "passcode"… */
  name: string;
  icon: AppIconName;
  /** The device credential that also works, when `name` is a biometric. */
  fallback: string | null;
}

const deviceCredential = () => (Platform.OS === "ios" ? "passcode" : "screen lock");

/**
 * Only a phone that answers "nothing enrolled" goes without App Lock. One that fails to answer
 * keeps it and asks for its passcode, which the system prompt offers whenever one is set.
 */
export async function unlockMethod(): Promise<UnlockMethod> {
  try {
    return await enrolledMethod();
  } catch {
    return { available: true, name: deviceCredential(), icon: "lock", fallback: null };
  }
}

async function enrolledMethod(): Promise<UnlockMethod> {
  const credential = deviceCredential();
  const level = await LocalAuthentication.getEnrolledLevelAsync();
  if (level === LocalAuthentication.SecurityLevel.NONE)
    return { available: false, name: credential, icon: "lock", fallback: null };
  // Weak (camera-only) face unlock is not offered by name; those phones show their screen lock.
  if (level !== LocalAuthentication.SecurityLevel.BIOMETRIC_STRONG)
    return { available: true, name: credential, icon: "lock", fallback: null };
  const types = await LocalAuthentication.supportedAuthenticationTypesAsync();
  const face = types.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION);
  const finger = types.includes(LocalAuthentication.AuthenticationType.FINGERPRINT);
  if (Platform.OS === "ios") {
    return face
      ? { available: true, name: "Face ID", icon: "faceid", fallback: credential }
      : { available: true, name: "Touch ID", icon: "fingerprint", fallback: credential };
  }
  return {
    available: true,
    name: finger && !face ? "fingerprint" : "biometrics",
    icon: "fingerprint",
    fallback: credential,
  };
}

export type UnlockResult = "unlocked" | "cancelled" | "lockout" | "unavailable" | "failed";

let authenticating = false;
const ended = new Set<(result: UnlockResult) => void>();

/** The system prompt makes the app inactive (and, for an Android PIN, background) briefly. */
export function isAuthenticating(): boolean {
  return authenticating;
}

/** Runs after every prompt, wherever it was asked, before its caller sees the result. */
export function onAuthenticationEnd(listener: (result: UnlockResult) => void): () => void {
  ended.add(listener);
  return () => ended.delete(listener);
}

export async function authenticate(promptMessage: string): Promise<UnlockResult> {
  authenticating = true;
  let result: UnlockResult = "failed";
  try {
    result = await ask(promptMessage);
  } finally {
    authenticating = false;
    for (const listener of [...ended]) listener(result);
  }
  return result;
}

/**
 * Android 9 and 10 refuse strong biometrics combined with the screen lock, so the prompt would
 * fail every time; they accept "weak", which still includes every strong sensor.
 */
function biometricLevel(): "strong" | "weak" {
  const api = Platform.OS === "android" ? Number(Platform.Version) : 0;
  return api === 28 || api === 29 ? "weak" : "strong";
}

async function ask(promptMessage: string): Promise<UnlockResult> {
  try {
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage,
      cancelLabel: "Cancel",
      disableDeviceFallback: false,
      biometricsSecurityLevel: biometricLevel(),
    });
    if (result.success) return "unlocked";
    switch (result.error) {
      case "user_cancel":
      case "system_cancel":
      case "app_cancel":
        return "cancelled";
      case "lockout":
        return "lockout";
      case "not_enrolled":
      case "not_available":
      case "passcode_not_set":
        return "unavailable";
      default:
        return "failed";
    }
  } catch {
    return "failed";
  }
}
