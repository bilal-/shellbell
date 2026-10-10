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

export async function unlockMethod(): Promise<UnlockMethod> {
  const credential = Platform.OS === "ios" ? "passcode" : "screen lock";
  const level = await LocalAuthentication.getEnrolledLevelAsync();
  if (level === LocalAuthentication.SecurityLevel.NONE)
    return { available: false, name: credential, icon: "lock", fallback: null };
  // Weak (camera-only) face unlock is not accepted on Android; those phones use their screen lock.
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

/** The system prompt makes the app inactive (and, for an Android PIN, background) briefly. */
export function isAuthenticating(): boolean {
  return authenticating;
}

export async function authenticate(promptMessage: string): Promise<UnlockResult> {
  authenticating = true;
  try {
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage,
      cancelLabel: "Cancel",
      disableDeviceFallback: false,
      biometricsSecurityLevel: "strong",
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
  } finally {
    authenticating = false;
  }
}
