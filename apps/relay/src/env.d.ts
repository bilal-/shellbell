import type { ComputerDO } from "./computer-do.js";

export interface Env {
  COMPUTER: DurableObjectNamespace<ComputerDO>;
  /** Private secrets supplied by the operator; never committed in Wrangler vars. */
  FCM_SERVICE_ACCOUNT_JSON?: string;
  APNS_PRIVATE_KEY?: string;
  APNS_TEAM_ID?: string;
  APNS_KEY_ID?: string;
  APNS_TOPIC?: string;
  MIN_FRAME_MS?: string;
  /** Cloudflare TURN key; both are secrets. Without them devices use STUN only. */
  TURN_KEY_ID?: string;
  TURN_KEY_API_TOKEN?: string;
}
