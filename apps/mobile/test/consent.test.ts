import { beforeEach, expect, it, vi } from "vitest";
import {
  acceptRelay,
  acceptTerms,
  hasAcceptedRelay,
  hasAcceptedTerms,
  TERMS_VERSION,
} from "../src/store/consent";
import { consentData, consentStorage, resetConsentStorage } from "./helpers/consent-storage";

vi.mock("expo-sqlite/kv-store", async () => ({
  default: (await import("./helpers/consent-storage")).consentStorage,
}));
beforeEach(resetConsentStorage);

it("requires the current terms version with an acceptance date", () => {
  expect(hasAcceptedTerms()).toBe(false);
  acceptTerms();
  expect(hasAcceptedTerms()).toBe(true);
  expect(JSON.parse(consentData.get("shellbell.terms.v1")!)).toMatchObject({
    version: TERMS_VERSION,
  });
  consentData.set(
    "shellbell.terms.v1",
    JSON.stringify({ version: "older", acceptedAt: new Date().toISOString() }),
  );
  expect(hasAcceptedTerms()).toBe(false);
  consentData.set(
    "shellbell.terms.v1",
    JSON.stringify({ version: TERMS_VERSION, acceptedAt: "invalid" }),
  );
  expect(hasAcceptedTerms()).toBe(false);
});

it("remembers normalized relay origins but not different ports, schemes or servers", () => {
  acceptRelay(" WSS://PRIVATE.example.com:443/ ");
  expect(hasAcceptedRelay("wss://private.example.com")).toBe(true);
  for (const origin of [
    "ws://private.example.com",
    "wss://private.example.com:444",
    "wss://another.example.com",
  ]) {
    expect(hasAcceptedRelay(origin)).toBe(false);
  }
});

it("bounds stored relay choices and requires a fresh choice after notice revisions", () => {
  for (let i = 0; i < 65; i++) acceptRelay(`wss://relay${i}.example.com`);
  expect(hasAcceptedRelay("wss://relay0.example.com")).toBe(false);
  expect(hasAcceptedRelay("wss://relay64.example.com")).toBe(true);
  const record = JSON.parse(consentData.get("shellbell.relay-consent.v1")!);
  expect(record.origins).toHaveLength(64);
  consentData.set("shellbell.relay-consent.v1", JSON.stringify({ ...record, version: 0 }));
  expect(hasAcceptedRelay("wss://relay64.example.com")).toBe(false);
});

it.each(["broken json", "null", "42", '"text"', "[]", '{"version":1,"origins":{}}'])(
  "does not accept corrupt records: %s",
  (raw) => {
    consentData.set("shellbell.terms.v1", raw);
    consentData.set("shellbell.relay-consent.v1", raw);
    expect(hasAcceptedTerms()).toBe(false);
    expect(hasAcceptedRelay("wss://private.example.com")).toBe(false);
  },
);

it("propagates unavailable storage instead of claiming consent was saved", () => {
  consentStorage.setItemSync.mockImplementation(() => {
    throw new Error("locked");
  });
  expect(acceptTerms).toThrow("locked");
  expect(() => acceptRelay("wss://private.example.com")).toThrow("locked");
  expect(hasAcceptedTerms()).toBe(false);
});
