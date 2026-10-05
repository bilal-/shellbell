import { type CtrlMessageOf, ProtocolError, parseCtrl } from "@shellbell/protocol";

// Preserve the original protocol exception and close semantics. Weak membership
// records its origin without retaining historical errors or changing core ports.
const inputRejections = new WeakSet<ProtocolError>();

/** Only pure caller validation belongs here: never SQL or persisted-row decoding. */
export function validateRepositoryInput<T>(validate: () => T): T {
  try {
    return validate();
  } catch (error) {
    if (error instanceof ProtocolError) inputRejections.add(error);
    throw error;
  }
}

export function isRepositoryInputRejection(error: unknown): boolean {
  return error instanceof ProtocolError && inputRejections.has(error);
}

/** Validate provider/platform/environment together before registration cancels any work. */
export function validatePushRegistration(message: CtrlMessageOf<"push-token">): void {
  validateRepositoryInput(() => parseCtrl(message));
}
