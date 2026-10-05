import { PrivateRecordStore } from "../private-record-store.js";
import { NATIVE_RECORD_BYTES, type NativeRecord, NativeRecordSchema } from "./protocol.js";

export type { NativeRecordTransaction } from "./protocol.js";
export class NativeRecordStore extends PrivateRecordStore<NativeRecord> {
  constructor(options: { root: string; uid: number; newId?: () => string }) {
    super({
      ...options,
      filename: "controller.json",
      maxBytes: NATIVE_RECORD_BYTES,
      schema: NativeRecordSchema,
    });
  }
}
