import Ajv from "ajv";
import sessionSchema from "./fixtures/session-v1.schema.json";
import schema from "./fixtures/transcripts-v1.schema.json";

const validate = new Ajv({ strict: true }).compile(schema);
const validateSession = new Ajv({ strict: true }).compile(sessionSchema);
export function validateSessionFixture(value: unknown): void {
  if (!validateSession(value))
    throw new Error(`Invalid session fixture: ${JSON.stringify(validateSession.errors)}`);
}
export function validateTranscripts(value: unknown): void {
  if (!validate(value))
    throw new Error(`Invalid relay transcripts: ${JSON.stringify(validate.errors)}`);
}
