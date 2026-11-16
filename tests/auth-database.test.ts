import assert from "node:assert/strict";
import { test } from "node:test";
import type { PoolClient } from "pg";
import { authDatabase, consumeAuthRateLimit, withAuthDatabase } from "../src/lib/auth-database";

// Only constructs a pool; the facade must route every actual query to our
// synthetic transaction client and never connect to this address.
process.env.DATABASE_URL = "postgresql://synthetic:synthetic@127.0.0.1:1/synthetic";
const authPool = authDatabase();

function client() {
  const statements: string[] = [];
  let releases = 0;
  const connection = {
    async query(sql: string) {
      statements.push(sql);
      return { command: sql.split(" ")[0].toUpperCase(), rows: [], rowCount: 0 };
    },
    release() { releases++; },
  } as unknown as PoolClient;
  return { connection, statements, releases: () => releases };
}

test("auth adapter rejects unscoped and direct pool access", async () => {
  await assert.rejects(authPool.connect(), /active access transaction/);
  await assert.rejects(consumeAuthRateLimit("synthetic", { window: 60, max: 3 }), /active access transaction/);
  assert.throws(() => authPool.query("SELECT 1"), /Unsupported authentication pool operation/);
});

test("auth transactions use savepoints without committing or releasing the outer transaction", async () => {
  const db = client();
  await withAuthDatabase(db.connection, async () => {
    const lease = await authPool.connect();
    await lease.query("begin");
    await lease.query("SELECT 'first'");
    await lease.query("commit");
    await lease.query("begin");
    await lease.query("SELECT 'second'");
    await lease.query("rollback");
    lease.release();
  });
  assert.deepEqual(db.statements, [
    "SAVEPOINT auth_scope_1", "SELECT 'first'", "RELEASE SAVEPOINT auth_scope_1",
    "SAVEPOINT auth_scope_2", "SELECT 'second'", "ROLLBACK TO SAVEPOINT auth_scope_2", "RELEASE SAVEPOINT auth_scope_2",
  ]);
  assert.equal(db.releases(), 0);
});

test("auth leases serialize sibling work without interleaving transactions", async () => {
  const db = client();
  await withAuthDatabase(db.connection, async () => {
    const first = await authPool.connect();
    await first.query("begin");
    let acquired = false;
    const waiting = authPool.connect().then(lease => { acquired = true; return lease; });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(acquired, false);
    await first.query("commit");
    first.release();
    const second = await waiting;
    await second.query("begin");
    await second.query("rollback");
    second.release();
  });
  assert.deepEqual(db.statements, ["SAVEPOINT auth_scope_1", "RELEASE SAVEPOINT auth_scope_1", "SAVEPOINT auth_scope_2", "ROLLBACK TO SAVEPOINT auth_scope_2", "RELEASE SAVEPOINT auth_scope_2"]);
});

test("simultaneous auth scopes keep their transaction clients separate", async () => {
  const first = client(), second = client();
  await Promise.all([first, second].map((db, index) => withAuthDatabase(db.connection, async () => {
    const lease = await authPool.connect();
    await new Promise<void>(resolve => setImmediate(resolve));
    await lease.query(`SELECT ${index}`);
    lease.release();
  })));
  assert.deepEqual(first.statements, ["SELECT 0"]);
  assert.deepEqual(second.statements, ["SELECT 1"]);
});

test("dirty, discarded, and unreleased leases prevent a successful auth scope", async () => {
  for (const mode of ["dirty", "discarded", "unreleased"] as const) {
    const db = client();
    await assert.rejects(withAuthDatabase(db.connection, async () => {
      const lease = await authPool.connect();
      if (mode === "dirty") await lease.query("begin");
      if (mode !== "unreleased") lease.release(mode === "discarded");
    }), /did not finish cleanly/);
    assert.equal(db.releases(), 0);
  }
});

test("released leases and delayed work cannot write after the auth scope closes", async () => {
  const db = client();
  let retained!: PoolClient;
  let resume!: () => void;
  let delayed!: Promise<void>;
  await withAuthDatabase(db.connection, async () => {
    retained = await authPool.connect();
    retained.release();
    delayed = (async () => {
      await new Promise<void>(resolve => { resume = resolve; });
      await assert.rejects(authPool.connect(), /active access transaction/);
    })();
  });
  await assert.rejects(retained.query("SELECT 'late'"), /lease is closed/);
  resume();
  await delayed;
  assert.deepEqual(db.statements, []);
});
