import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import type { Client } from "pg";
import { exportRecoveryLedger } from "../scripts/backup-ledger";
import { hardenRestore, validateLedger } from "../scripts/backup-restore";

const member = "10000000-0000-4000-8000-000000000001";
const post = "20000000-0000-4000-8000-000000000001";
const comment = "30000000-0000-4000-8000-000000000001";
const chat = "40000000-0000-4000-8000-000000000001";

async function fixture() {
  const asset = (name: string) => readFile(`node_modules/@electric-sql/pglite/dist/${name}`);
  const db = await PGlite.create({
    fsBundle: new Blob([new Uint8Array(await asset("pglite.data"))]),
    pgliteWasmModule: await WebAssembly.compile(new Uint8Array(await asset("pglite.wasm"))),
    initdbWasmModule: await WebAssembly.compile(new Uint8Array(await asset("initdb.wasm"))),
  });
  for (const name of ["001_initial.sql", "002_rate_limit_expiry.sql", "003_operator_lifecycle.sql", "004_human_community_chat.sql"])
    await db.exec(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
  // Existing owner default grants must not accidentally expose the new tables.
  await db.exec(`CREATE ROLE journal_runtime;
    ALTER DEFAULT PRIVILEGES GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON TABLES TO journal_runtime;
    ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO journal_runtime;`);
  await db.exec("BEGIN");
  await db.exec(await readFile(new URL("../migrations/005_recovery_journal.sql", import.meta.url), "utf8"));
  await db.exec("COMMIT");
  await db.exec(`GRANT USAGE ON SCHEMA public TO journal_runtime;
    GRANT SELECT, INSERT, UPDATE, DELETE ON members, posts, comments, chat_messages TO journal_runtime;
    GRANT USAGE ON SEQUENCE chat_messages_position_seq TO journal_runtime;
    INSERT INTO "user" (id,name,email) VALUES ('fixture','Fixture','journal@example.test');
    INSERT INTO members (id,user_id,first_name,last_name) VALUES ('${member}','fixture','Fixture','Person');
    INSERT INTO posts(id,author_id,body) VALUES ('${post}','${member}','Old private post');
    INSERT INTO comments(id,post_id,author_id,body) VALUES ('${comment}','${post}','${member}','Old private reply');
    INSERT INTO chat_messages(id,author_id,body) VALUES ('${chat}','${member}','Old private chat');`);
  const client = { query: async (text: string, values?: unknown[]) => {
    const result = await db.query(text, values);
    return { ...result, rowCount: result.affectedRows ?? result.rows.length };
  } } as unknown as Pick<Client, "query">;
  const backup = { id: "database-journal-fixture", startedAt: "" };
  const stamp = (await db.query<{ started: Date }>("SELECT record_recovery_boundary($1) AS started", [backup.id])).rows[0].started;
  backup.startedAt = stamp.toISOString();
  await db.query("SELECT pg_sleep(0.002)");
  return { db, client, backup };
}

test("journal commits all deletion/edit/block intents, survives unblock, and rolls back failed writes", async () => {
  const { db, client, backup } = await fixture();
  try {
    await db.exec(`BEGIN; UPDATE members SET blocked_at=now(); DELETE FROM comments; ROLLBACK;`);
    assert.deepEqual((await db.query("SELECT * FROM recovery_journal")).rows, []);
    await db.exec(`SET ROLE journal_runtime;
      UPDATE members SET blocked_at=now(); UPDATE members SET blocked_at=NULL;
      UPDATE posts SET body='Edited post'; UPDATE comments SET body='Edited reply';
      DELETE FROM chat_messages; RESET ROLE;`);
    const ledger = await exportRecoveryLedger(client, backup);
    assert.deepEqual(ledger.blockedMemberIds, [member]);
    assert.deepEqual(ledger.deletedPostIds, [post]);
    assert.deepEqual(ledger.deletedCommentIds, [comment]);
    assert.deepEqual(ledger.deletedChatMessageIds, [chat]);
    assert.equal(JSON.stringify(ledger).includes("private"), false);
    assert.equal(JSON.stringify(ledger).includes("@"), false);
    assert.throws(() => validateLedger(ledger, backup, Date.now() + 2 * 60 * 60_000));
    // Account deletion produces its own intent even when content rows are gone.
    await db.exec(`DELETE FROM comments; DELETE FROM posts; DELETE FROM members;`);
    assert.deepEqual((await exportRecoveryLedger(client, backup)).deletedMemberIds, [member]);
  } finally { await db.close(); }
});

test("runtime cannot read or tamper with journal, metadata, health or trigger functions", async () => {
  const { db } = await fixture();
  try {
    await db.exec("SET ROLE journal_runtime");
    for (const sql of [
      "SELECT * FROM recovery_journal", "SELECT * FROM recovery_journal_state", "SELECT * FROM backup_health",
      `INSERT INTO recovery_journal (kind,entity_id) VALUES ('member_delete','${member}')`,
      "DELETE FROM recovery_journal", "TRUNCATE recovery_journal", "UPDATE recovery_journal_state SET installed_at=now()",
      "UPDATE backup_health SET backup_id='false',last_verified_at=now()", "SELECT record_recovery_intent()",
      "SELECT export_recovery_journal('database-fake',now())", "SELECT record_recovery_boundary('database-fake')",
      "SELECT * FROM recovery_backup_boundaries",
    ]) await assert.rejects(db.query(sql), /permission denied/);
    await db.exec("RESET ROLE");
    await db.exec("GRANT SELECT ON backup_health TO journal_runtime; SET ROLE journal_runtime");
    assert.equal((await db.query("SELECT * FROM backup_health")).rows.length, 1);
    await assert.rejects(db.query("UPDATE backup_health SET backup_id='false',last_verified_at=now()"), /permission denied/);
    await db.exec("RESET ROLE");
    for (const sql of ["TRUNCATE members CASCADE", "TRUNCATE posts CASCADE", "TRUNCATE comments", "TRUNCATE chat_messages",
      "TRUNCATE recovery_journal", "DELETE FROM recovery_journal", "UPDATE recovery_journal_state SET installed_at=now()"])
      await assert.rejects(db.query(sql), /coverage must be preserved/);
  } finally { await db.close(); }
});

test("dedicated backup role exports a locked snapshot with EXECUTE and no application write grants", async () => {
  const { db, client, backup } = await fixture();
  try {
    await db.exec(`CREATE ROLE journal_backup;
      GRANT USAGE ON SCHEMA public TO journal_backup;
      GRANT EXECUTE ON FUNCTION public.export_recovery_journal(text,timestamptz) TO journal_backup;
      SET ROLE journal_backup;`);
    await assert.rejects(db.query("UPDATE members SET blocked_at=now()"), /permission denied/);
    await assert.rejects(db.query("SELECT * FROM recovery_journal"), /permission denied/);
    assert.equal((await exportRecoveryLedger(client, backup)).complete, true);
    await assert.rejects(exportRecoveryLedger(client, { ...backup, id: "database-unregistered" }));
    await db.exec("RESET ROLE");
  } finally { await db.close(); }
});

test("export fails closed on pre-install backup, missing metadata, or disabled recording", async () => {
  const { db, client, backup } = await fixture();
  try {
    await assert.rejects(exportRecoveryLedger(client, { ...backup, startedAt: "2020-01-01T00:00:00.000Z" }));
    await db.exec("ALTER TABLE posts DISABLE TRIGGER recovery_posts");
    await assert.rejects(exportRecoveryLedger(client, backup));
    await db.exec("ALTER TABLE posts ENABLE ALWAYS TRIGGER recovery_posts; DROP TABLE recovery_journal_state");
    await assert.rejects(exportRecoveryLedger(client, backup));
  } finally { await db.close(); }
});

test("restore hardening remains transactional with installed owner-defined triggers", async () => {
  const { db, client, backup } = await fixture();
  try {
    const ledger = await exportRecoveryLedger(client, backup);
    ledger.deletedMemberIds = [member];
    await db.exec("UPDATE backup_health SET backup_id='before-restore',last_verified_at=now()");
    // pg_restore --no-privileges recreates the default PUBLIC function EXECUTE.
    await db.exec("GRANT EXECUTE ON FUNCTION export_recovery_journal(text,timestamptz), record_recovery_boundary(text) TO PUBLIC");
    await hardenRestore(client, ledger);
    assert.equal((await db.query("SELECT * FROM members")).rows.length, 0);
    assert.equal((await db.query("SELECT * FROM chat_messages")).rows.length, 0);
    assert.deepEqual((await db.query("SELECT body,author_id FROM posts")).rows, [{ body: "", author_id: null }]);
    assert.equal((await db.query("SELECT * FROM community_control WHERE paused_at IS NOT NULL")).rows.length, 1);
    assert.deepEqual((await db.query("SELECT backup_id,last_verified_at FROM backup_health")).rows, [{ backup_id: null, last_verified_at: null }]);
    assert.deepEqual((await exportRecoveryLedger(client, backup)).deletedMemberIds, [member]);
    await db.exec("SET ROLE journal_runtime");
    await assert.rejects(db.query("SELECT export_recovery_journal($1,$2::timestamptz)", [backup.id, backup.startedAt]), /permission denied/);
    await assert.rejects(db.query("SELECT record_recovery_boundary('database-fake')"), /permission denied/);
    await db.exec("RESET ROLE");
  } finally { await db.close(); }
});

test("verified boundary preserves earlier edits but captures repeat edits after the backup", async () => {
  const { db, client } = await fixture();
  try {
    await db.exec("UPDATE posts SET body='Committed before backup'; UPDATE comments SET body='Earlier edit'");
    await db.query("SELECT pg_sleep(0.003)");
    const backup = { id: "database-after-earlier-edit", startedAt: "" };
    const stamp = (await db.query<{ started: Date }>("SELECT record_recovery_boundary($1) AS started", [backup.id])).rows[0].started;
    backup.startedAt = stamp.toISOString();
    const before = await exportRecoveryLedger(client, backup);
    assert.deepEqual(before.deletedPostIds, []);
    assert.deepEqual(before.deletedCommentIds, []);
    await db.exec("UPDATE posts SET body='Edited again after backup'; UPDATE comments SET body='Later edit'");
    const after = await exportRecoveryLedger(client, backup);
    assert.deepEqual(after.deletedPostIds, [post]);
    assert.deepEqual(after.deletedCommentIds, [comment]);
    await assert.rejects(db.query("UPDATE recovery_journal SET last_affected_at=now()"), /coverage must be preserved/);
    await assert.rejects(exportRecoveryLedger(client, { ...backup, startedAt: new Date(Date.parse(backup.startedAt) + 1).toISOString() }));
  } finally { await db.close(); }
});
