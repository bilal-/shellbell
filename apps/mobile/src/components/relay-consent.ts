import { Alert } from "react-native";
import { acceptRelay, hasAcceptedRelay } from "../store/consent";
import { isCustomRelay, relayTrustMessage } from "../util/relay-trust";

export class RelayConsentError extends Error {}

/** Check the caller again after the native dialog, before recording or applying its choice. */
export async function requestRelayConsent(
  value: string,
  isCurrent: () => boolean,
): Promise<boolean> {
  if (!isCurrent()) return false;
  if (!isCustomRelay(value)) return true;
  try {
    if (hasAcceptedRelay(value)) return true;
  } catch {
    throw new RelayConsentError("Could not read your saved relay choices. Please try again.");
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (agreed: boolean) => {
      if (settled) return;
      settled = true;
      if (!agreed || !isCurrent()) return resolve(false);
      try {
        acceptRelay(value);
        resolve(true);
      } catch {
        reject(new RelayConsentError("Could not save your relay choice. Please try again."));
      }
    };
    Alert.alert(
      "Trust this custom relay?",
      relayTrustMessage(value),
      [
        { text: "Decline", style: "cancel", onPress: () => finish(false) },
        { text: "Agree", onPress: () => finish(true) },
      ],
      { cancelable: true, onDismiss: () => finish(false) },
    );
  });
}
