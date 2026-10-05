import { fingerprint } from "@shellbell/protocol";
import type { IdentityStore } from "../src/ports/identity-store.js";
import type { ComputerRecord, PairingRecord } from "../src/ports/models.js";

type Equal = (actual: unknown, expected: unknown) => void;
export interface IdentityStoreHarness {
  store: IdentityStore;
  computer: ComputerRecord;
  seedNotifications(phoneFp: string): void | Promise<void>;
  notificationCounts(phoneFp: string): Promise<readonly number[]>;
  failRevocation(phoneFp: string): void | Promise<void>;
  failPairingWrite(phoneFp: string): void | Promise<void>;
  clearFailure(): void | Promise<void>;
}

export function pairingFixture(seed: number): PairingRecord {
  const publicKey = new Uint8Array(32).fill(seed);
  return {
    phoneFp: fingerprint(publicKey),
    publicKey,
    name: `Phone ${seed}`,
    pushToken: null,
    pushPlatform: null,
    pushEnabled: true,
    pairedAt: 100,
    lastSeenAt: null,
  };
}

async function rejects(action: () => Promise<unknown>, equal: Equal) {
  let rejected = false;
  try {
    await action();
  } catch {
    rejected = true;
  }
  equal(rejected, true);
}

interface IdentityScenario {
  name: string;
  run(h: IdentityStoreHarness, equal: Equal): Promise<void>;
}

/** Storage-independent behavior; failure injection belongs to each adapter's test harness. */
export const identityStoreScenarios: readonly IdentityScenario[] = [
  {
    name: "clears orphan metadata but preserves a registered computer",
    async run(h, equal) {
      const a = pairingFixture(1);
      await h.store.addPairing(a, 100);
      await h.seedNotifications(a.phoneFp);
      await h.store.openWindow(new Uint8Array(32), 200);
      await h.store.revoke(pairingFixture(2).phoneFp, true, 100);
      equal(await h.store.deleteOrphanedComputer(), true);
      equal(await h.store.pairings(), []);
      equal(await h.store.window(), null);
      equal(await h.store.pendingRevocations(), []);
      equal(await h.notificationCounts(a.phoneFp), [0, 0, 0, 0]);
      await h.store.registerComputer(h.computer);
      await h.store.addPairing(a, 100);
      equal(await h.store.deleteOrphanedComputer(), false);
      equal(await h.store.computer(), h.computer);
      equal(await h.store.pairing(a.phoneFp), a);
    },
  },
  {
    name: "returns empty identity state before registration",
    async run({ store }, equal) {
      equal(await store.computer(), null);
      equal(await store.pairings(), []);
      equal(await store.pairing(pairingFixture(1).phoneFp), null);
      equal(await store.window(), null);
      equal(await store.pendingRevocations(), []);
    },
  },
  {
    name: "preserves registration origin and updates name and last seen",
    async run({ store, computer }, equal) {
      await store.registerComputer(computer);
      await store.registerComputer({ ...computer, name: "Renamed", firstSeen: 200, lastSeen: 300 });
      await store.markSeen(400);
      equal(await store.computer(), { ...computer, name: "Renamed", lastSeen: 400 });
    },
  },
  {
    name: "marks a phone seen without resurrecting a revoked pairing",
    async run({ store }, equal) {
      const a = pairingFixture(1);
      await store.addPairing(a, 100);
      await store.markPairingSeen(a.phoneFp, 250);
      equal(await store.pairing(a.phoneFp), { ...a, lastSeenAt: 250 });
      await store.revoke(a.phoneFp, true, 300);
      await store.markPairingSeen(a.phoneFp, 350);
      equal(await store.pairing(a.phoneFp), null);
      equal(await store.pendingRevocations(), [a.phoneFp]);
    },
  },
  {
    name: "copies key and gate bytes at write and read boundaries",
    async run({ store, computer }, equal) {
      const phone = pairingFixture(1);
      const key = phone.publicKey.slice();
      await store.registerComputer(computer);
      await store.addPairing(phone, 100);
      const gate = new Uint8Array(32).fill(2);
      await store.openWindow(gate, 500);
      phone.publicKey.fill(9);
      computer.publicKey.fill(9);
      gate.fill(9);
      const row = await store.pairing(phone.phoneFp);
      equal(row?.publicKey, key);
      row?.publicKey.fill(8);
      (await store.pairings())[0]?.publicKey.fill(8);
      (await store.computer())?.publicKey.fill(8);
      (await store.window())?.gateHash.fill(8);
      equal((await store.pairing(phone.phoneFp))?.publicKey, key);
      equal((await store.computer())?.publicKey, new Uint8Array(32).fill(50));
      equal((await store.window())?.gateHash, new Uint8Array(32).fill(2));
    },
  },
  {
    name: "rejects mismatched and expired gates without consuming admission slots",
    async run({ store }, equal) {
      const gate = new Uint8Array(32).fill(2);
      equal(await store.admitPairing(gate, 100), "closed");
      await store.openWindow(gate, 500);
      equal(await store.admitPairing(new Uint8Array(32).fill(3), 100), "closed");
      equal((await store.window())?.admitted, 0);
      equal(await store.admitPairing(gate, 500), "expired");
      equal((await store.window())?.admitted, 0);
      await store.closeWindow();
      equal(await store.window(), null);
    },
  },
  {
    name: "admits exactly one of two concurrent requests for the final gate slot",
    async run({ store }, equal) {
      const gate = new Uint8Array(32).fill(2);
      await store.openWindow(gate, 500);
      for (let i = 0; i < 4; i++) equal(await store.admitPairing(gate, 100), "admitted");
      const results = await Promise.all([
        store.admitPairing(gate, 100),
        store.admitPairing(gate, 100),
      ]);
      equal([...results].sort(), ["admitted", "full"]);
      equal((await store.window())?.admitted, 5);
      await store.openWindow(gate, 600);
      equal((await store.window())?.admitted, 0);
      equal(await store.admitPairing(gate, 100), "admitted");
    },
  },
  {
    name: "persists and replaces pair IDs without retaining a stale ID on legacy sync",
    async run({ store }, equal) {
      const a = pairingFixture(1);
      const first = { ...a, pairId: new Uint8Array(32).fill(3) };
      await store.addPairing(first, 100);
      equal((await store.pairing(a.phoneFp))?.pairId, first.pairId);
      const second = { ...a, pairId: new Uint8Array(32).fill(4) };
      await store.syncPairings([second], 200);
      equal((await store.pairing(a.phoneFp))?.pairId, second.pairId);
      await store.syncPairings([a], 300);
      equal((await store.pairing(a.phoneFp))?.pairId, undefined);
    },
  },
  {
    name: "enforces ten pairings while allowing retained metadata updates",
    async run({ store }, equal) {
      for (let i = 1; i <= 10; i++) equal(await store.addPairing(pairingFixture(i), 100), "added");
      equal(await store.addPairing(pairingFixture(11), 100), "full");
      const existing = pairingFixture(1);
      equal(await store.addPairing({ ...existing, name: "Renamed", pairedAt: 200 }, 200), "added");
      equal(await store.pairing(existing.phoneFp), { ...existing, name: "Renamed" });
      equal((await store.pairings()).length, 10);
    },
  },
  {
    name: "admits one concurrent pairing into the final pairing capacity slot",
    async run({ store }, equal) {
      for (let i = 1; i <= 9; i++) await store.addPairing(pairingFixture(i), 100);
      const results = await Promise.all([
        store.addPairing(pairingFixture(10), 100),
        store.addPairing(pairingFixture(11), 100),
      ]);
      equal([...results].sort(), ["added", "full"]);
      equal((await store.pairings()).length, 10);
    },
  },
  {
    name: "revokes pairing and all phone notification state without touching another phone",
    async run(h, equal) {
      const a = pairingFixture(1),
        b = pairingFixture(2);
      await h.store.addPairing(a, 100);
      await h.store.addPairing(b, 100);
      await h.seedNotifications(a.phoneFp);
      await h.seedNotifications(b.phoneFp);
      await h.store.revoke(a.phoneFp, true, 200);
      equal(await h.store.pairing(a.phoneFp), null);
      equal(await h.notificationCounts(a.phoneFp), [0, 0, 0, 0]);
      equal(await h.notificationCounts(b.phoneFp), [1, 1, 1, 1]);
      equal(await h.store.pairing(b.phoneFp), b);
      equal(await h.store.pendingRevocations(), [a.phoneFp]);
      equal(await h.store.pendingRevocations(), [a.phoneFp]);
      equal(await h.store.addPairing(a, 300), "revoked");
    },
  },
  {
    name: "retains a bounded signed proof with its offline tombstone until sync acknowledges it",
    async run(h, equal) {
      const phone = pairingFixture(1);
      const proof = {
        v: 2 as const,
        computerFp: h.computer.fingerprint,
        phoneFp: phone.phoneFp,
        pairId: new Uint8Array(32).fill(3),
        signature: new Uint8Array(64).fill(4),
      };
      await h.store.addPairing(phone, 100);
      await h.store.revoke(phone.phoneFp, true, 200, proof);
      equal(await h.store.pendingRevocationProofs(), [proof]);
      await h.store.revoke(phone.phoneFp, true, 201);
      equal(await h.store.pendingRevocationProofs(), [proof]);
      await h.store.syncPairings([], 300);
      equal(await h.store.pendingRevocationProofs(), [proof]);
      equal(await h.store.acknowledgeRevocationProof(phone.phoneFp, new Uint8Array(32)), false);
      equal(await h.store.acknowledgeRevocationProof(phone.phoneFp, proof.pairId), true);
      equal(await h.store.pendingRevocationProofs(), []);
    },
  },
  {
    name: "never deletes a signed pairing when pending proof capacity is exhausted",
    async run(h, equal) {
      for (let i = 1; i <= 10; i++) {
        const phone = pairingFixture(i);
        await h.store.addPairing(phone, 100);
        await h.store.revoke(phone.phoneFp, true, 200);
      }
      const overflow = pairingFixture(11);
      await h.store.addPairing(overflow, 100);
      const proof = {
        v: 2 as const,
        computerFp: h.computer.fingerprint,
        phoneFp: overflow.phoneFp,
        pairId: new Uint8Array(32).fill(5),
        signature: new Uint8Array(64).fill(6),
      };
      equal(await h.store.revoke(overflow.phoneFp, true, 201, proof), false);
      equal(await h.store.pairing(overflow.phoneFp), overflow);
      equal(await h.store.pendingRevocationProofs(), []);
    },
  },
  {
    name: "preserves the legacy ten-tombstone cap while still deleting overflow phone state",
    async run(h, equal) {
      const phones = Array.from({ length: 10 }, (_, i) => pairingFixture(i + 1));
      for (const phone of phones) {
        await h.store.addPairing(phone, 100);
        await h.store.revoke(phone.phoneFp, true, 200);
      }
      const overflow = pairingFixture(11);
      equal(await h.store.addPairing(overflow, 300), "added");
      await h.seedNotifications(overflow.phoneFp);
      await h.store.revoke(overflow.phoneFp, true, 400);
      equal(await h.store.pairing(overflow.phoneFp), null);
      equal(await h.notificationCounts(overflow.phoneFp), [0, 0, 0, 0]);
      equal([...(await h.store.pendingRevocations())].sort(), phones.map((p) => p.phoneFp).sort());
    },
  },
  {
    name: "applies tombstones before stale sync metadata and acknowledges them atomically",
    async run(h, equal) {
      const a = pairingFixture(1);
      const b = {
        ...pairingFixture(2),
        pushToken: "ExponentPushToken[retained]",
        pushPlatform: "ios",
        pushEnabled: false,
        lastSeenAt: 123,
      };
      await h.store.addPairing(a, 100);
      await h.store.addPairing(b, 100);
      await h.store.revoke(a.phoneFp, true, 200);
      equal(
        await h.store.syncPairings(
          [a, { ...pairingFixture(2), name: "Renamed", pairedAt: 300 }],
          300,
        ),
        [a.phoneFp],
      );
      equal(await h.store.pairing(a.phoneFp), null);
      equal(await h.store.pairing(b.phoneFp), { ...b, name: "Renamed" });
      equal(await h.store.pendingRevocations(), []);
      equal(await h.store.addPairing(a, 400), "added");
    },
  },
  {
    name: "sync removes omitted pairings with their notification state",
    async run(h, equal) {
      const a = pairingFixture(1),
        b = pairingFixture(2);
      await h.store.addPairing(a, 100);
      await h.store.addPairing(b, 100);
      await h.seedNotifications(a.phoneFp);
      await h.seedNotifications(b.phoneFp);
      equal(await h.store.syncPairings([b], 200), []);
      equal(await h.store.pairing(a.phoneFp), null);
      equal(await h.notificationCounts(a.phoneFp), [0, 0, 0, 0]);
      equal(await h.notificationCounts(b.phoneFp), [1, 1, 1, 1]);
    },
  },
  {
    name: "rejects oversized and duplicate sync input without changing stored pairings",
    async run({ store }, equal) {
      const a = pairingFixture(1);
      await store.addPairing(a, 100);
      await rejects(
        () =>
          store.syncPairings(
            Array.from({ length: 11 }, (_, i) => pairingFixture(i + 1)),
            200,
          ),
        equal,
      );
      await rejects(() => store.syncPairings([a, a], 200), equal);
      equal(await store.pairings(), [a]);
    },
  },
  {
    name: "rolls back pairing and notification deletion when revocation fails",
    async run(h, equal) {
      const a = {
        ...pairingFixture(1),
        pushToken: "ExponentPushToken[original]",
        pushPlatform: "ios",
        pushEnabled: false,
        lastSeenAt: 123,
      };
      await h.store.addPairing(a, 100);
      await h.seedNotifications(a.phoneFp);
      await h.failRevocation(a.phoneFp);
      await rejects(() => h.store.revoke(a.phoneFp, true, 200), equal);
      equal(await h.store.pairing(a.phoneFp), a);
      equal(await h.notificationCounts(a.phoneFp), [1, 1, 1, 1]);
      equal(await h.store.pendingRevocations(), []);
      await h.clearFailure();
      await h.store.revoke(a.phoneFp, true, 200);
      equal(await h.store.pairing(a.phoneFp), null);
    },
  },
  {
    name: "rolls back sync removal metadata and tombstone acknowledgement on import failure",
    async run(h, equal) {
      const a = pairingFixture(1),
        b = { ...pairingFixture(2), pushEnabled: false },
        c = pairingFixture(3),
        d = pairingFixture(4);
      await h.store.addPairing(a, 100);
      await h.store.addPairing(b, 100);
      await h.store.addPairing(d, 100);
      await h.seedNotifications(d.phoneFp);
      await h.store.revoke(a.phoneFp, true, 200);
      await h.failPairingWrite(c.phoneFp);
      await rejects(() => h.store.syncPairings([a, { ...b, name: "Changed" }, c], 300), equal);
      equal(await h.store.pairing(a.phoneFp), null);
      equal(await h.store.pairing(b.phoneFp), b);
      equal(await h.store.pairing(c.phoneFp), null);
      equal(await h.store.pairing(d.phoneFp), d);
      equal(await h.notificationCounts(d.phoneFp), [1, 1, 1, 1]);
      equal(await h.store.pendingRevocations(), [a.phoneFp]);
      await h.clearFailure();
      equal(await h.store.syncPairings([a, b, c], 300), [a.phoneFp]);
      equal(await h.store.pairing(a.phoneFp), null);
    },
  },
  {
    name: "expires computers only after ninety days and clears identity and notification rows",
    async run(h, equal) {
      const a = pairingFixture(1);
      const retention = 90 * 24 * 3600 * 1000;
      equal(await h.store.deleteExpiredComputer(retention + 101), false);
      await h.store.registerComputer(h.computer);
      await h.store.addPairing(a, 100);
      await h.seedNotifications(a.phoneFp);
      await h.store.openWindow(new Uint8Array(32), 200);
      await h.store.revoke(pairingFixture(2).phoneFp, true, 150);
      equal(await h.store.deleteExpiredComputer(retention + 100), false);
      equal(await h.store.deleteExpiredComputer(retention + 101), true);
      equal(await h.store.computer(), null);
      equal(await h.store.pairings(), []);
      equal(await h.store.window(), null);
      equal(await h.store.pendingRevocations(), []);
      equal(await h.notificationCounts(a.phoneFp), [0, 0, 0, 0]);
      await h.store.registerComputer(h.computer);
      equal(await h.store.computer(), h.computer);
    },
  },
];
