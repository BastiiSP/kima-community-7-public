import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import type { Client } from "pg";
import { hardenRestore, type RecoveryLedger } from "../scripts/backup-restore";

const alice = "10000000-0000-4000-8000-000000000001", bob = "10000000-0000-4000-8000-000000000002";
const post = "20000000-0000-4000-8000-000000000001", removedPost = "20000000-0000-4000-8000-000000000002";
const survivingReply = "30000000-0000-4000-8000-000000000001", removedReply = "30000000-0000-4000-8000-000000000002";
const chat = "40000000-0000-4000-8000-000000000001";
const ledger: RecoveryLedger = { format: 1, backupId: "fixture", backupStartedAt: new Date().toISOString(), reviewedThrough: new Date().toISOString(), complete: true,
  blockedMemberIds: [bob], deletedMemberIds: [alice], deletedPostIds: [removedPost], deletedCommentIds: [removedReply], deletedChatMessageIds: [chat] };

test("restore reapplies account/content deletion and blocking, invalidates all old access, and stays paused", async () => {
  const db = new PGlite();
  try {
    for (const migration of ["001_initial.sql", "002_rate_limit_expiry.sql", "003_operator_lifecycle.sql", "004_human_community_chat.sql"]) await db.exec(await readFile(new URL(`../migrations/${migration}`, import.meta.url), "utf8"));
    await db.exec(`INSERT INTO "user" (id,name,email) VALUES ('alice','Alice','alice@example.test'), ('bob','Bob','bob@example.test');
      INSERT INTO members (id,user_id,first_name,last_name) VALUES ('${alice}','alice','Alice','Fixture'),('${bob}','bob','Bob','Fixture');
      INSERT INTO session (id,token,"expiresAt","userId") VALUES ('s','old-session',now()+interval '1 day','bob');
      INSERT INTO verification (id,identifier,value,"expiresAt") VALUES ('v','sign-in-otp-bob@example.test','old-otp',now()+interval '1 day');
      INSERT INTO invitations(id,token_hash,created_by,expires_at) VALUES ('50000000-0000-4000-8000-000000000001','old-invite','${bob}',now()+interval '1 day');
      INSERT INTO agent_tokens (id,member_id,name,token_hash,expires_at) VALUES ('60000000-0000-4000-8000-000000000001','${bob}','fixture','old-agent',now()+interval '1 day');
      INSERT INTO posts (id,author_id,body) VALUES ('${post}','${alice}','Account deletion removes this'),('${removedPost}','${bob}','Explicit post deletion removes this');
      INSERT INTO comments (id,post_id,author_id,body) VALUES ('${survivingReply}','${post}','${bob}','Keep other member reply'),('${removedReply}','${post}','${bob}','Explicit deletion removes this');
      INSERT INTO chat_messages(id,author_id,body) VALUES ('${chat}','${bob}','Explicit chat deletion removes this'),('40000000-0000-4000-8000-000000000002','${alice}','Account deletion removes this');
      INSERT INTO account(id,"accountId","providerId","userId","accessToken") VALUES ('a','alice','fixture','alice','old-account-secret');`);
    // PGlite's affectedRows is adapted to pg's rowCount. This tests actual SQL and constraints.
    const client = { query: async (text: string, values?: unknown[]) => {
      const result = await db.query(text, values);
      return { ...result, rowCount: result.affectedRows ?? result.rows.length };
    } } as unknown as Pick<Client, "query">;
    await hardenRestore(client, ledger);
    assert.equal((await db.query('SELECT id FROM "user" WHERE id=\'alice\'')).rows.length, 0);
    assert.equal((await db.query('SELECT id FROM account')).rows.length, 0);
    assert.equal((await db.query("SELECT id FROM session UNION ALL SELECT id FROM verification")).rows.length, 0);
    assert.equal((await db.query("SELECT id FROM invitations WHERE revoked_at IS NULL UNION ALL SELECT id FROM agent_tokens WHERE revoked_at IS NULL")).rows.length, 0);
    assert.equal((await db.query("SELECT id FROM members WHERE blocked_at IS NOT NULL")).rows.length, 1);
    assert.equal((await db.query("SELECT id FROM posts WHERE body='' AND deleted_at IS NOT NULL")).rows.length, 2);
    assert.equal((await db.query("SELECT id FROM posts WHERE author_id IS NULL")).rows.length, 1);
    assert.deepEqual((await db.query("SELECT id FROM comments")).rows, [{ id: survivingReply }]);
    assert.equal((await db.query("SELECT id FROM chat_messages")).rows.length, 0);
    assert.equal((await db.query("SELECT id FROM community_control WHERE paused_at IS NOT NULL")).rows.length, 1);
  } finally { await db.close(); }
});

test("restore hardening failure rolls back and never claims a successful pause", async () => {
  const calls: string[] = [];
  const client = { query: async (sql: string) => { calls.push(sql); return { rowCount: 0, rows: [] }; } } as unknown as Pick<Client, "query">;
  await assert.rejects(hardenRestore(client, ledger));
  assert.equal(calls.at(-1), "ROLLBACK");
  assert.equal(calls.includes("COMMIT"), false);
});
