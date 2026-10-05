export interface RuntimeServices {
  now(): number;
  randomBytes(length: number): Uint8Array;
  randomId(): string;
  report(event: "storage-failure" | "provider-failure" | "overload" | "invalid-session"): void;
}
