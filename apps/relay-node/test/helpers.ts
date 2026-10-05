import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fingerprint } from "@shellbell/protocol";
import { openRelayDatabase } from "../src/storage/database.js";

export function computerFixture(seed = 50) {
  const publicKey = new Uint8Array(32).fill(seed);
  return {
    fingerprint: fingerprint(publicKey),
    publicKey,
    name: "Mac",
    firstSeen: 100,
    lastSeen: 100,
  };
}
export function temporaryDirectory() {
  return mkdtempSync(join(realpathSync(tmpdir()), "shellbell-storage-test-"));
}
export function fixture() {
  const dir = temporaryDirectory();
  let attentive = false;
  const options = { attentive: () => attentive };
  let database = openRelayDatabase(dir, options);
  let sql = new DatabaseSync(join(dir, "relay.sqlite"));
  return {
    dir,
    get database() {
      return database;
    },
    get sql() {
      return sql;
    },
    attentive(value: boolean) {
      attentive = value;
    },
    restart() {
      sql.close();
      // close performs synchronous teardown before resolving its Promise.
      void database.close();
      database = openRelayDatabase(dir, options);
      sql = new DatabaseSync(join(dir, "relay.sqlite"));
    },
    async close() {
      sql.close();
      await database.close();
      rmSync(dir, { recursive: true });
    },
    count(table: string, computerFp: string, phone?: string) {
      return Number(
        sql
          .prepare(
            `SELECT COUNT(*) AS n FROM ${table} WHERE computer_fp = ?${phone ? " AND phone_fp = ?" : ""}`,
          )
          .get(...(phone ? [computerFp, phone] : [computerFp]))!.n,
      );
    },
  };
}
