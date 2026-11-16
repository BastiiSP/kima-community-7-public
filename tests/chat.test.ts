import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { chatPage } from "../src/lib/chat";
import { ApiError } from "../src/lib/errors";

test("chat cursors keep bigint precision and reject ambiguous or malformed selections", () => {
  const request = (query: string) => new Request(`https://community.example/api/chat?${query}`);
  assert.deepEqual(chatPage(request("")), { before: null, after: null });
  assert.deepEqual(chatPage(request("after=0")), { before: null, after: "0" });
  assert.deepEqual(chatPage(request("before=9223372036854775807")), { before: "9223372036854775807", after: null });
  for (const query of ["before=0&after=1", "before=", "after=-1", "after=1.1", "after=01", "after=1e3", "after=9223372036854775808", "after=1&after=2", "before=1&before=2"]) {
    assert.throws(() => chatPage(request(query)), (error: unknown) => error instanceof ApiError && error.status === 400, query);
  }
});

test("additive chat migration revokes old keys, keeps provenance and removes deleted-member chat", async () => {
  // Explicit assets support workspace paths containing a literal #.
  const asset = async (name: string) => new Uint8Array(await readFile(`node_modules/@electric-sql/pglite/dist/${name}`));
  const db = await PGlite.create({
    fsBundle: new Blob([await asset("pglite.data")]),
    pgliteWasmModule: await WebAssembly.compile(await asset("pglite.wasm")),
    initdbWasmModule: await WebAssembly.compile(await asset("initdb.wasm")),
  });
  try {
    for (const migration of ["001_initial.sql", "002_rate_limit_expiry.sql", "003_operator_lifecycle.sql"]) {
      await db.exec(await readFile(`migrations/${migration}`, "utf8"));
    }
    const member = randomUUID(), tokenId = randomUUID(), post = randomUUID();
    await db.query('INSERT INTO "user"(id,name,email) VALUES ($1,$2,$3)', ["historical-user", "Altbestand", "history@example.test"]);
    await db.query("INSERT INTO members(id,user_id,first_name,last_name) VALUES ($1,'historical-user','Alt','Bestand')", [member]);
    await db.query("INSERT INTO agent_tokens(id,member_id,name,token_hash,expires_at) VALUES ($1,$2,'Früherer Helfer','synthetic-hash',now()+interval '1 day')", [tokenId, member]);
    await db.query("INSERT INTO posts(id,author_id,body,agent_name) VALUES ($1,$2,'Erhaltenswerter Text','Früherer Helfer')", [post, member]);
    await db.exec(await readFile("migrations/004_human_community_chat.sql", "utf8"));
    assert.equal((await db.query<{ revoked: boolean }>("SELECT revoked_at IS NOT NULL AS revoked FROM agent_tokens WHERE id=$1", [tokenId])).rows[0].revoked, true);
    assert.deepEqual((await db.query("SELECT body,agent_name FROM posts WHERE id=$1", [post])).rows[0], { body: "Erhaltenswerter Text", agent_name: "Früherer Helfer" });
    const chat = randomUUID();
    await db.query("INSERT INTO chat_messages(id,author_id,body) VALUES ($1,$2,'Nur vor Löschung')", [chat, member]);
    const first = (await db.query<{ cursor: string }>("SELECT position::text AS cursor FROM chat_messages WHERE id=$1", [chat])).rows[0].cursor;
    await db.query("DELETE FROM chat_messages WHERE id=$1", [chat]);
    await db.query("INSERT INTO chat_messages(id,author_id,body) VALUES ($1,$2,'Neue Position')", [chat, member]);
    const second = (await db.query<{ cursor: string }>("SELECT position::text AS cursor FROM chat_messages WHERE id=$1", [chat])).rows[0].cursor;
    assert.ok(BigInt(second) > BigInt(first), "deletion must never reuse a polling cursor");
    await db.query("DELETE FROM posts WHERE author_id=$1", [member]);
    await db.query("DELETE FROM agent_tokens WHERE member_id=$1", [member]);
    await db.query("DELETE FROM members WHERE id=$1", [member]);
    assert.equal((await db.query("SELECT id FROM chat_messages")).rows.length, 0);
  } finally { await db.close(); }
});
