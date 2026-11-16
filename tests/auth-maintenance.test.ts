import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import type { Pool } from "pg";
import nodemailer from "nodemailer";
import { maintainExpiredAuth } from "../src/lib/auth-maintenance";
import { GET } from "../src/app/api/ops/backup-health/route";

async function fixture(onBegin?: (db: PGlite) => Promise<void>) {
  const db = new PGlite();
  await db.exec(await readFile(new URL("../migrations/001_initial.sql", import.meta.url), "utf8"));
  await db.exec(`INSERT INTO "user" (id,name,email) VALUES ('fixture','Fixture','fixture@example.test');
    INSERT INTO account(id,"accountId","providerId","userId") VALUES ('account','fixture','fixture','fixture');`);
  let released = false;
  const pool = { connect: async () => ({
    query: async (sql: string, values?: unknown[]) => {
      const result = await db.query(sql, values);
      if (sql === "BEGIN") await onBegin?.(db);
      return { ...result, rowCount: result.affectedRows ?? result.rows.length };
    },
    release: () => { released = true; },
  }) } as unknown as Pick<Pool, "connect">;
  return { db, pool, released: () => released };
}

test("auth maintenance keeps expiry boundaries, valid access and accounts", async () => {
  const f = await fixture(async db => {
    // Seed at transaction time so equality is tested against the exact cleanup cutoff.
    await db.exec(`INSERT INTO session(id,token,"userId","expiresAt") VALUES
      ('expired','expired','fixture',CURRENT_TIMESTAMP-interval '1 millisecond'),
      ('boundary','boundary','fixture',CURRENT_TIMESTAMP),
      ('valid','valid','fixture',CURRENT_TIMESTAMP+interval '1 day');
      INSERT INTO verification(id,identifier,value,"expiresAt") VALUES
      ('expired','fixture','expired',CURRENT_TIMESTAMP-interval '1 millisecond'),
      ('boundary','fixture','boundary',CURRENT_TIMESTAMP),
      ('valid','fixture','valid',CURRENT_TIMESTAMP+interval '5 minutes');
      INSERT INTO "rateLimit"(id,key,count,"lastRequest") VALUES
      ('expired','expired',1,floor(extract(epoch FROM CURRENT_TIMESTAMP-interval '24 hours')*1000)-1),
      ('boundary','boundary',1,floor(extract(epoch FROM CURRENT_TIMESTAMP-interval '24 hours')*1000)),
      ('valid','valid',1,extract(epoch FROM CURRENT_TIMESTAMP-interval '30 seconds')*1000),
      ('future','future',1,extract(epoch FROM CURRENT_TIMESTAMP+interval '1 day')*1000);`);
  });
  try {
    const result = await maintainExpiredAuth(f.pool);
    assert.deepEqual(result, { sessions: 1, verifications: 1, rateLimits: 1 });
    for (const table of ['session', 'verification']) {
      assert.deepEqual((await f.db.query(`SELECT id FROM ${table} ORDER BY id`)).rows, [{ id: "boundary" }, { id: "valid" }]);
    }
    assert.deepEqual((await f.db.query('SELECT id FROM "rateLimit" ORDER BY id')).rows, [{ id: "boundary" }, { id: "future" }, { id: "valid" }]);
    assert.equal((await f.db.query('SELECT id FROM account')).rows.length, 1);
    assert.equal((await f.db.query('SELECT id FROM "user"')).rows.length, 1);
    assert.equal(f.released(), true);
  } finally { await f.db.close(); }
});

test("auth maintenance deletes at most 100 expired rows per table and repeated runs progress", async () => {
  const f = await fixture();
  try {
    await f.db.exec(`INSERT INTO session(id,token,"userId","expiresAt")
      SELECT 's'||n,'s'||n,'fixture',now()-interval '1 day' FROM generate_series(1,105) n;
      INSERT INTO verification(id,identifier,value,"expiresAt")
      SELECT 'v'||n,'fixture','expired',now()-interval '1 day' FROM generate_series(1,105) n;
      INSERT INTO "rateLimit"(id,key,count,"lastRequest")
      SELECT 'r'||n,'r'||n,1,0 FROM generate_series(1,105) n;`);
    assert.deepEqual(await maintainExpiredAuth(f.pool), { sessions: 100, verifications: 100, rateLimits: 100 });
    for (const table of ['session', 'verification', '"rateLimit"']) assert.equal((await f.db.query(`SELECT id FROM ${table}`)).rows.length, 5);
    assert.deepEqual(await maintainExpiredAuth(f.pool), { sessions: 5, verifications: 5, rateLimits: 5 });
    assert.deepEqual(await maintainExpiredAuth(f.pool), { sessions: 0, verifications: 0, rateLimits: 0 });
  } finally { await f.db.close(); }
});

test("auth maintenance rolls the entire batch back and releases the client on database failure", async () => {
  const f = await fixture();
  try {
    await f.db.exec(`INSERT INTO session(id,token,"userId","expiresAt") VALUES ('expired','expired','fixture',now()-interval '1 day');
      INSERT INTO verification(id,identifier,value,"expiresAt") VALUES ('expired','fixture','expired',now()-interval '1 day');
      CREATE FUNCTION reject_cleanup() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture failure'; END $$;
      CREATE TRIGGER reject_cleanup BEFORE DELETE ON verification FOR EACH ROW EXECUTE FUNCTION reject_cleanup();`);
    await assert.rejects(maintainExpiredAuth(f.pool), /fixture failure/);
    assert.equal((await f.db.query('SELECT id FROM session')).rows.length, 1);
    assert.equal((await f.db.query('SELECT id FROM verification')).rows.length, 1);
    assert.equal((await f.db.query('SELECT id FROM "user"')).rows.length, 1);
    assert.equal(f.released(), true);
  } finally { await f.db.close(); }
});

test("cron auth gates maintenance and backup alert results survive maintenance failures", async () => {
  const state = globalThis as typeof globalThis & { communityPool?: Pool };
  const previousPool = state.communityPool;
  const variables = ["CRON_SECRET", "DATABASE_URL", "OPS_ALERT_EMAIL", "SMTP_HOST", "SMTP_USER", "SMTP_PASS", "SMTP_FROM"];
  const previous = variables.map(key => process.env[key]);
  let connections = 0, reads = 0, alerts = 0;
  let stale = false, maintenanceFails = false, mailFails = false;
  const secret = "a".repeat(64);
  const transport = mock.method(nodemailer, "createTransport", () => ({
    sendMail: async () => { alerts++; if (mailFails) throw new Error("fixture mail failure"); },
    close: () => {},
  }));
  const log = mock.method(console, "error", () => {});
  try {
    for (const key of variables) process.env[key] = "fixture";
    process.env.CRON_SECRET = secret;
    state.communityPool = {
      query: async () => { reads++; return { rows: stale ? [] : [{ backup_id: "database-20261116T172300Z-10000000-0000-4000-8000-000000000001", last_verified_at: new Date() }] }; },
      connect: async () => {
        connections++;
        return { query: async (sql: string) => {
          if (sql.includes("DELETE") && maintenanceFails) throw new Error("fixture maintenance failure");
          return { rows: [], rowCount: 0 };
        }, release: () => {} };
      },
    } as unknown as Pool;
    const request = (authorized = true) => new Request("http://localhost/api/ops/backup-health", { headers: authorized ? { authorization: `Bearer ${secret}` } : {} });
    assert.equal((await GET(request(false))).status, 401);
    assert.equal(reads, 0);
    assert.equal(connections, 0);
    let response = await GET(request());
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { healthy: true, alerted: false, maintenanceOk: true });
    assert.equal(alerts, 0);
    maintenanceFails = true;
    response = await GET(request());
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { healthy: true, alerted: false, maintenanceOk: false });
    stale = true;
    response = await GET(request());
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { healthy: false, alerted: true, maintenanceOk: false });
    assert.equal(alerts, 1);
    maintenanceFails = false;
    mailFails = true;
    response = await GET(request());
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { healthy: false, alerted: false, maintenanceOk: true });
    assert.equal(connections, 4, "Maintenance still runs when the backup alert fails");
  } finally {
    variables.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; });
    if (previousPool === undefined) delete state.communityPool; else state.communityPool = previousPool;
    transport.mock.restore();
    log.mock.restore();
  }
});
