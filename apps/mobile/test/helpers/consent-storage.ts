import { vi } from "vitest";

export const consentData = new Map<string, string>();
export const consentStorage = {
  getItemSync: vi.fn((key: string) => consentData.get(key) ?? null),
  setItemSync: vi.fn((key: string, value: string) => {
    consentData.set(key, value);
  }),
};
export function resetConsentStorage() {
  consentData.clear();
  consentStorage.getItemSync.mockReset().mockImplementation((key) => consentData.get(key) ?? null);
  consentStorage.setItemSync.mockReset().mockImplementation((key, value) => {
    consentData.set(key, value);
  });
}
