import { describe, expect, it } from "vitest";
import {
  evictUnpairedComputers,
  lookupSessionTitle,
  saveSessionTitles,
  type TitleStorage,
} from "../src/notifications/sessionTitles";

function memory(): TitleStorage {
  const m = new Map<string, string>();
  return {
    getItemSync: (k) => m.get(k) ?? null,
    setItemSync: (k, v) => void m.set(k, v),
  };
}
const s = (id: string, title: string, backend = "tmux") => ({ id, title, backend });

describe("session title persistence", () => {
  it("does not rewrite unchanged notification labels for activity-only session updates", () => {
    const st = memory();
    let writes = 0;
    const storage = {
      getItemSync: st.getItemSync,
      setItemSync: (key: string, value: string) => {
        writes++;
        st.setItemSync(key, value);
      },
    };
    saveSessionTitles("fp1", [s("s1", "one"), s("s2", "two")], storage);
    // Reordering/state changes do not change the persistent title lookup.
    saveSessionTitles("fp1", [s("s2", "two"), s("s1", "one")], storage);
    expect(writes).toBe(1);
    saveSessionTitles("fp1", [s("s1", "renamed")], storage);
    expect(writes).toBe(2);
    expect(lookupSessionTitle("fp1", "s1", storage)?.title).toBe("renamed");
    expect(lookupSessionTitle("fp1", "s2", storage)).toBeUndefined();
  });
  it("round-trips a title so a backgrounded app can name the session", () => {
    const st = memory();
    saveSessionTitles("fp1", [s("s1", "claude-code", "herdr")], st);
    expect(lookupSessionTitle("fp1", "s1", st)).toEqual({ title: "claude-code", backend: "herdr" });
  });

  it("returns undefined for an unseen session", () => {
    expect(lookupSessionTitle("fp1", "nope", memory())).toBeUndefined();
  });

  it("keeps computers separate", () => {
    const st = memory();
    saveSessionTitles("fp1", [s("s1", "one")], st);
    saveSessionTitles("fp2", [s("s1", "two")], st);
    expect(lookupSessionTitle("fp1", "s1", st)?.title).toBe("one");
    expect(lookupSessionTitle("fp2", "s1", st)?.title).toBe("two");
  });

  it("evicts sessions absent from the latest list", () => {
    const st = memory();
    saveSessionTitles("fp1", [s("s1", "one"), s("s2", "two")], st);
    saveSessionTitles("fp1", [s("s1", "one")], st);
    expect(lookupSessionTitle("fp1", "s2", st)).toBeUndefined();
  });

  it("survives corrupt stored JSON instead of throwing", () => {
    const st = memory();
    st.setItemSync("shellbell.sessionTitles", "{not json");
    expect(lookupSessionTitle("fp1", "s1", st)).toBeUndefined();
    saveSessionTitles("fp1", [s("s1", "ok")], st);
    expect(lookupSessionTitle("fp1", "s1", st)?.title).toBe("ok");
  });

  /**
   * Spec §5: "cap total entries per computer" — defense in depth even though the protocol already
   * bounds a single `sessions` message to 500 (`packages/protocol/src/inner.ts:95`); this cap must
   * hold regardless of what produced the list (review Minor).
   */
  it("caps entries per computer instead of storing an unbounded list", () => {
    const st = memory();
    const many = Array.from({ length: 600 }, (_, i) => s(`s${i}`, `title${i}`));
    saveSessionTitles("fp1", many, st);
    expect(lookupSessionTitle("fp1", "s0", st)?.title).toBe("title0");
    expect(lookupSessionTitle("fp1", "s599", st)).toBeUndefined();
  });
});

/**
 * Spec §5's bound is per-session; review Minor additionally asks that an unpaired computer's
 * whole entry not linger forever. Wired from `settings.tsx`'s unpair handler.
 */
describe("evictUnpairedComputers (review Minor)", () => {
  it("removes entries for computers no longer paired", () => {
    const st = memory();
    saveSessionTitles("fp1", [s("s1", "one")], st);
    saveSessionTitles("fp2", [s("s1", "two")], st);
    evictUnpairedComputers(["fp2"], st);
    expect(lookupSessionTitle("fp1", "s1", st)).toBeUndefined();
    expect(lookupSessionTitle("fp2", "s1", st)?.title).toBe("two");
  });

  it("is a no-op when every stored computer is still paired", () => {
    const st = memory();
    saveSessionTitles("fp1", [s("s1", "one")], st);
    evictUnpairedComputers(["fp1", "fp2"], st);
    expect(lookupSessionTitle("fp1", "s1", st)?.title).toBe("one");
  });
});
