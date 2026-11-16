import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, copyFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { TestContext } from "node:test";
import type { testRuntime } from "./runtime";

// Run inside the existing HTTP fixture: a second Next process in the same
// directory would race its build output and does not improve coverage.
export async function operatorWorkflows(t: TestContext, runtime: Awaited<ReturnType<typeof testRuntime>>) {
  const exec = promisify(execFile);
  const ops = (...args: string[]) => exec(process.execPath, ["--import", "tsx", "scripts/operator.ts", ...args], {
    env: { ...process.env, NODE_ENV: "test", DATABASE_URL: runtime.databaseUrl }, timeout: 30_000,
  });
  async function request(path: string, options: { cookie?: string; token?: string; method?: string; body?: unknown } = {}) {
    const headers: Record<string, string> = { "Content-Type": "application/json", Origin: runtime.origin };
    if (options.cookie) headers.Cookie = options.cookie;
    if (options.token) headers.Authorization = `Bearer ${options.token}`;
    const response = await fetch(runtime.origin + path, { method: options.method ?? "GET", headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
    return { status: response.status, data: await response.json() };
  }
  async function resetLimits() { await runtime.db.exec('DELETE FROM app_rate_limits; DELETE FROM "rateLimit";'); }
  async function member(email: string, firstName: string) {
    await resetLimits();
    const cookie = await runtime.login(email);
    const joined = await request("/api/join", { cookie, method: "POST", body: { token: await runtime.bootstrapInvite(), firstName, lastName: "Testkonto" } });
    assert.equal(joined.status, 201);
    return { email, cookie, id: joined.data.member.id as string };
  }
  async function credentials(cookie: string) {
    // Synthetic legacy metadata: no route can issue or authenticate these keys.
    const token = randomBytes(32).toString("base64url");
    const member = (await request("/api/community", { cookie })).data.member;
    await runtime.db.query("INSERT INTO agent_tokens(id,member_id,name,token_hash,expires_at) VALUES ($1,$2,'Altmetadaten',$3,now()+interval '1 day')", [randomUUID(), member.id, createHash("sha256").update(token).digest("hex")]);
    const invitation = await request("/api/invitations", { cookie, method: "POST" });
    assert.equal(invitation.status, 201);
    const invite = new URLSearchParams(new URL(invitation.data.url).hash.slice(1)).get("invite")!;
    return { token, invite };
  }
  await t.test("failed migration batch rolls back earlier files and emits no applied claim", async () => {
    const fixture = await mkdtemp(join(process.cwd(), ".migration-check-"));
    try {
      await mkdir(join(fixture, "scripts"));
      await mkdir(join(fixture, "migrations"));
      for (const name of ["migrate.ts", "operator-config.ts"]) await copyFile(join("scripts", name), join(fixture, "scripts", name));
      await writeFile(join(fixture, "migrations", "901_probe.sql"), "CREATE TABLE operator_migration_probe (id integer PRIMARY KEY);\n");
      await writeFile(join(fixture, "migrations", "902_failure.sql"), "SELECT * FROM deliberately_missing_migration_table;\n");
      await assert.rejects(exec(process.execPath, ["--import", "tsx", join(fixture, "scripts", "migrate.ts")], {
        env: { ...process.env, NODE_ENV: "test", DATABASE_URL: runtime.databaseUrl }, timeout: 30_000,
      }), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(!String((error as Error & { stdout?: string }).stdout).includes("Migration angewandt"));
        return true;
      });
      assert.equal((await runtime.db.query<{ table_name: string | null }>("SELECT to_regclass('operator_migration_probe')::text AS table_name")).rows[0].table_name, null);
      assert.equal((await runtime.db.query("SELECT name FROM schema_migrations WHERE name IN ('901_probe.sql', '902_failure.sql')")).rows.length, 0);
    } finally { await rm(fixture, { recursive: true, force: true }); }
  });

  const owner = await member("operator-target@example.test", "Zielperson");
  const other = await member("operator-other@example.test", "Andere");
  let fresh = owner.cookie;
  let access = await credentials(fresh);
  const initialToken = access.token;

  await t.test("operator changes require exact confirmation; no public admin endpoint", async () => {
    await ops("status");
    await ops("member", owner.id);
    await assert.rejects(ops("block", owner.id));
    await assert.rejects(ops("delete", owner.id, "--confirm", other.id));
    await assert.rejects(ops("block", "not-a-uuid", "--confirm", "not-a-uuid"));
    assert.equal((await request("/api/community", { cookie: fresh })).status, 200);
    assert.equal((await fetch(runtime.origin + "/api/admin/members")).status, 404);
  });

  await t.test("block closes human and agent access, cannot be bypassed by rejoining; unblock never revives credentials", async () => {
    assert.equal((await request("/api/auth/email-otp/send-verification-otp", { method: "POST", body: { email: owner.email, type: "sign-in" } })).status, 200);
    const preBlockOtp = runtime.otpFor(owner.email);
    await ops("block", owner.id, "--confirm", owner.id);
    for (const auth of [{ cookie: fresh }, { token: access.token }]) {
      assert.ok((await request("/api/community", auth)).status >= 400);
      assert.ok((await request("/api/posts", { ...auth, method: "POST", body: { body: "Blocked" } })).status >= 400);
      assert.ok((await request("/api/chat", auth)).status >= 400);
      assert.ok((await request("/api/chat", { ...auth, method: "POST", body: { body: "Blocked chat" } })).status >= 400);
    }
    const send = await request("/api/auth/email-otp/send-verification-otp", { method: "POST", body: { email: owner.email, type: "sign-in" } });
    assert.ok(send.status >= 400);
    assert.ok((await request("/api/join", { cookie: fresh, method: "POST", body: { token: await runtime.bootstrapInvite(), firstName: "Bypass", lastName: "Versuch" } })).status >= 400);
    assert.equal((await request("/api/community", { cookie: other.cookie })).status, 200);
    await ops("unblock", owner.id, "--confirm", owner.id);
    assert.equal((await request("/api/community", { cookie: fresh })).status, 401);
    assert.equal((await request("/api/community", { token: access.token })).status, 403);
    await resetLimits();
    assert.ok((await request("/api/auth/sign-in/email-otp", { method: "POST", body: { email: owner.email, otp: preBlockOtp } })).status >= 400);
    fresh = await runtime.login(owner.email);
    assert.equal((await request("/api/community", { cookie: fresh })).status, 200);
    const applicant = await runtime.login("operator-applicant@example.test");
    assert.ok((await request("/api/join", { cookie: applicant, method: "POST", body: { token: access.invite, firstName: "Neu", lastName: "Test" } })).status >= 400);
  });

  await t.test("member emergency revocation clears every session, agent, pending invitation and OTP without blocking future login", async () => {
    await resetLimits();
    const secondSession = await runtime.login(owner.email);
    access = await credentials(fresh);
    assert.equal((await request("/api/auth/email-otp/send-verification-otp", { method: "POST", body: { email: owner.email, type: "sign-in" } })).status, 200);
    const otp = runtime.otpFor(owner.email);
    // Delay the request body after actor() succeeds. Revocation must invalidate
    // that previously accepted identity before the eventual database write.
    const key = createHash("sha256").update(`content:${owner.id}`).digest("hex");
    await runtime.db.query("DELETE FROM app_rate_limits WHERE key=$1", [key]);
    let bodyController!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start(controller) { bodyController = controller; controller.enqueue(new TextEncoder().encode('{"body":"')); } });
    const pending = fetch(runtime.origin + "/api/chat", { method: "POST", headers: { Cookie: fresh, Origin: runtime.origin, "Content-Type": "application/json" }, body: stream, duplex: "half" } as RequestInit);
    try {
      let entered = false;
      for (let attempt = 0; attempt < 40; attempt++) {
        if ((await runtime.db.query("SELECT key FROM app_rate_limits WHERE key=$1", [key])).rows.length) { entered = true; break; }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      assert.ok(entered, "delayed request must have passed its initial identity check");
      await ops("revoke", owner.id, "--confirm", owner.id);
    } finally {
      bodyController.enqueue(new TextEncoder().encode('Must never be published"}'));
      bodyController.close();
    }
    assert.equal((await pending).status, 401);
    assert.equal((await runtime.db.query("SELECT id FROM chat_messages WHERE body='Must never be published'")).rows.length, 0);
    for (const cookie of [fresh, secondSession]) assert.equal((await request("/api/community", { cookie })).status, 401);
    assert.equal((await request("/api/community", { token: access.token })).status, 403);
    assert.ok((await request("/api/auth/sign-in/email-otp", { method: "POST", body: { email: owner.email, otp } })).status >= 400);
    await resetLimits();
    fresh = await runtime.login(owner.email);
    assert.equal((await request("/api/community", { cookie: fresh })).status, 200);
  });

  await t.test("account deletion removes personal data and own text while preserving replies and unrelated OTP", async () => {
    await resetLimits();
    access = await credentials(fresh);
    const post = await request("/api/posts", { cookie: fresh, method: "POST", body: { body: "Eigener vertraulicher Text" } });
    assert.equal(post.status, 201);
    const reply = await request(`/api/posts/${post.data.id}/comments`, { cookie: other.cookie, method: "POST", body: { body: "Fremde Antwort bleibt" } });
    assert.equal(reply.status, 201);
    const otherPost = await request("/api/posts", { cookie: other.cookie, method: "POST", body: { body: "Fremder Beitrag bleibt" } });
    assert.equal(otherPost.status, 201);
    assert.equal((await request(`/api/posts/${otherPost.data.id}/comments`, { cookie: fresh, method: "POST", body: { body: "Eigener Kommentar entfernen" } })).status, 201);
    assert.equal((await request("/api/chat", { cookie: fresh, method: "POST", body: { body: "Eigener Chat entfernen" } })).status, 201);
    const otherChat = await request("/api/chat", { cookie: other.cookie, method: "POST", body: { body: "Fremder Chat bleibt" } });
    assert.equal(otherChat.status, 201);
    const user = await runtime.db.query<{ id: string }>('SELECT id FROM "user" WHERE email = $1', [owner.email]);
    for (const email of [owner.email, other.email]) assert.equal((await request("/api/auth/email-otp/send-verification-otp", { method: "POST", body: { email, type: "sign-in" } })).status, 200);
    const otherVerifications = await runtime.db.query<{ id: string }>('SELECT id FROM verification WHERE identifier LIKE $1', [`%${other.email}%`]);
    assert.ok(otherVerifications.rows.length > 0);
    const chatBeforeDeletion = (await request("/api/chat", { cookie: other.cookie })).data;
    await ops("delete", owner.id, "--confirm", owner.id);
    const chatAfterDeletion = (await request(`/api/chat?after=${chatBeforeDeletion.newerCursor}`, { cookie: other.cookie })).data;
    assert.notEqual(chatAfterDeletion.revision, chatBeforeDeletion.revision);
    assert.deepEqual(chatAfterDeletion.messages, []);
    for (const [sql, args] of [
      ['SELECT id FROM "user" WHERE id=$1', [user.rows[0].id]],
      ['SELECT id FROM members WHERE id=$1', [owner.id]],
      ['SELECT id FROM session WHERE "userId"=$1', [user.rows[0].id]],
      ['SELECT id FROM account WHERE "userId"=$1', [user.rows[0].id]],
      ['SELECT id FROM agent_tokens WHERE member_id=$1', [owner.id]],
      ['SELECT id FROM verification WHERE identifier LIKE $1', [`%${owner.email}%`]],
      ['SELECT id FROM comments WHERE author_id=$1', [owner.id]],
      ['SELECT id FROM chat_messages WHERE author_id=$1', [owner.id]],
    ] as const) assert.equal((await runtime.db.query(sql, [...args])).rows.length, 0, sql);
    assert.equal((await runtime.db.query('SELECT id FROM verification WHERE identifier LIKE $1', [`%${other.email}%`])).rows.length, otherVerifications.rows.length);
    const feed = await request("/api/community", { cookie: other.cookie });
    assert.equal(feed.status, 200);
    const tombstone = feed.data.posts.find((p: { id: string }) => p.id === post.data.id);
    assert.ok(tombstone);
    assert.equal((await runtime.db.query("SELECT id FROM chat_messages WHERE id=$1", [otherChat.data.message.id])).rows.length, 1);
    assert.equal(tombstone.deleted, true);
    assert.equal(tombstone.body, "");
    assert.equal(tombstone.authorId, null);
    assert.equal(tombstone.agentName, null);
    assert.equal(tombstone.comments[0].body, "Fremde Antwort bleibt");
    assert.equal(tombstone.comments[0].authorId, other.id);
    assert.ok(!JSON.stringify(feed.data).includes("Eigener vertraulicher Text"));
    assert.ok(!JSON.stringify(feed.data).includes("Eigener Kommentar entfernen"));
    assert.equal((await request("/api/community", { cookie: fresh })).status, 401);
    for (const token of [initialToken, access.token]) assert.equal((await request("/api/community", { token })).status, 403);
    await resetLimits();
    const again = await runtime.login(owner.email);
    assert.equal((await request("/api/community", { cookie: again })).status, 403);
    assert.ok((await request("/api/join", { cookie: again, method: "POST", body: { token: access.invite, firstName: "Neu", lastName: "Test" } })).status >= 400);
  });

  await t.test("global emergency persists until explicit resume and old credentials stay revoked", async () => {
    await resetLimits();
    const otherAccess = await credentials(other.cookie);
    await assert.rejects(ops("emergency"));
    assert.equal((await request("/api/community", { cookie: other.cookie })).status, 200);
    await ops("emergency", "--confirm", "emergency");
    for (const auth of [{ cookie: other.cookie }, { token: otherAccess.token }]) {
      assert.equal((await request("/api/community", auth)).status, 503);
      assert.equal((await request("/api/posts", { ...auth, method: "POST", body: { body: "During pause" } })).status, 503);
      assert.equal((await request("/api/chat", auth)).status, 503);
      assert.equal((await request("/api/chat", { ...auth, method: "POST", body: { body: "During pause" } })).status, 503);
    }
    assert.equal((await request("/api/auth/email-otp/send-verification-otp", { method: "POST", body: { email: other.email, type: "sign-in" } })).status, 503);
    assert.equal((await runtime.db.query("SELECT id FROM session")).rows.length, 0);
    assert.equal((await runtime.db.query("SELECT id FROM verification")).rows.length, 0);
    assert.equal((await runtime.db.query("SELECT id FROM agent_tokens WHERE revoked_at IS NULL")).rows.length, 0);
    await assert.rejects(ops("resume", "--confirm", "wrong"));
    await ops("resume", "--confirm", "resume");
    assert.equal((await request("/api/community", { cookie: other.cookie })).status, 401);
    assert.equal((await request("/api/community", { token: otherAccess.token })).status, 403);
    await resetLimits();
    const current = await runtime.login(other.email);
    assert.equal((await request("/api/community", { cookie: current })).status, 200);
    const applicant = await runtime.login("operator-after-emergency@example.test");
    assert.ok((await request("/api/join", { cookie: applicant, method: "POST", body: { token: otherAccess.invite, firstName: "Neu", lastName: "Test" } })).status >= 400);
  });
}
