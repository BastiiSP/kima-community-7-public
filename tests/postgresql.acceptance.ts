import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { postgresqlRuntime } from "./helpers/postgresql-runtime";

// Explicitly run in an isolated copy: node --import tsx --test tests/postgresql.acceptance.ts
// Intentionally excluded from the normal *.test.ts suite: requires a fresh real PG18 database.
test("real PostgreSQL: two members, invitation contention and operator/auth lifecycle", { timeout: 240000 }, async t => {
  const runtime = await postgresqlRuntime();
  t.after(() => runtime.close());
  const { db, request, ops, waitForBlocked } = runtime;
  const emailA = "acceptance-alice@example.test", emailB = "acceptance-bob@example.test";
  let cookieA = await runtime.login(emailA);
  let cookieB = await runtime.login(emailB);
  const applicant = await runtime.login("acceptance-applicant@example.test");
  async function join(cookie: string, token: string, firstName: string) {
    return request("/api/join", { cookie, method: "POST", body: { token, firstName, lastName: "Abnahme" } });
  }
  const bootstrap = randomBytes(32).toString("base64url");
  await db.query("INSERT INTO invitations (id,token_hash,expires_at) VALUES ($1,$2,now()+interval '1 day')", [randomUUID(), createHash("sha256").update(bootstrap).digest("hex")]);
  const first = await join(cookieA, bootstrap, "Alice");
  assert.equal(first.status, 201);
  const memberA = (await first.json()).member.id as string;
  const userA = (await db.query("SELECT user_id FROM members WHERE id=$1", [memberA])).rows[0].user_id as string;
  let memberB: string;
  async function invite(cookie: string) {
    const response = await request("/api/invitations", { cookie, method: "POST" });
    assert.equal(response.status, 201);
    const token = new URLSearchParams(new URL((await response.json()).url).hash.slice(1)).get("invite");
    assert.ok(token);
    return token;
  }
  async function json(path: string, cookie: string, method = "GET", body?: unknown) {
    const response = await request(path, { cookie, method, body });
    return { status: response.status, data: await response.json() };
  }
  await t.test("one invitation cannot be consumed by two concurrent authenticated applicants", async () => {
    const token = await invite(cookieA);
    const gate = await db.connect();
    let bob!: Promise<Response>, rival!: Promise<Response>;
    try {
      await gate.query("BEGIN");
      await gate.query("SELECT id FROM invitations WHERE token_hash=$1 FOR UPDATE", [createHash("sha256").update(token).digest("hex")]);
      const pid = (await gate.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      bob = join(cookieB, token, "Bob");
      const firstWait = await waitForBlocked("%FROM invitations%FOR UPDATE%");
      assert.ok(firstWait.some(row => row.blockers.includes(pid)));
      rival = join(applicant, token, "Rival");
      await waitForBlocked("%FROM invitations%FOR UPDATE%", 2);
      await gate.query("COMMIT");
      const results = await Promise.all([bob, rival]);
      assert.deepEqual(results.map(response => response.status), [201, 400]);
      memberB = (await results[0].json()).member.id;
      assert.equal((await db.query("SELECT count(*)::int AS n FROM members")).rows[0].n, 2);
      const invitation = await db.query("SELECT used_by, used_at FROM invitations WHERE token_hash=$1", [createHash("sha256").update(token).digest("hex")]);
      assert.equal(invitation.rows[0].used_by, memberB);
      assert.ok(invitation.rows[0].used_at);
      assert.equal((await request("/api/community", { cookie: applicant })).status, 403);
    } finally { await gate.query("ROLLBACK"); gate.release(); await Promise.allSettled([bob, rival].filter(Boolean)); }
  });

  await t.test("OTP replay and ordinary member ownership through real HTTP", async () => {
    await runtime.resetLimits();
    const otp = await runtime.sendOtp(emailA);
    const login = await runtime.verify(emailA, otp);
    assert.equal(login.status, 200);
    cookieA = runtime.cookie(login);
    assert.ok((await runtime.verify(emailA, otp)).status >= 400);
    const post = await json("/api/posts", cookieA, "POST", { body: "Abnahme Alice Beitrag" });
    assert.equal(post.status, 201);
    assert.equal((await json(`/api/posts/${post.data.id}`, cookieB, "PATCH", { body: "Unerlaubt" })).status, 404);
    assert.equal((await json(`/api/posts/${post.data.id}/comments`, cookieB, "POST", { body: "Abnahme Bob Antwort bleibt" })).status, 201);
    const message = await json("/api/chat", cookieA, "POST", { body: "Abnahme Alice Chat löschen" });
    assert.equal(message.status, 201);
    assert.equal((await json(`/api/chat/${message.data.message.id}`, cookieB, "DELETE")).status, 404);
    const before = (await json("/api/chat", cookieB)).data.revision;
    assert.equal((await json(`/api/chat/${message.data.message.id}`, cookieA, "DELETE")).status, 200);
    const after = (await json("/api/chat", cookieB)).data;
    assert.notEqual(after.revision, before);
    assert.ok(!after.messages.some((entry: { id: string }) => entry.id === message.data.message.id));
    assert.equal((await json("/api/chat", cookieB, "POST", { body: "Abnahme Bob Chat bleibt" })).status, 201);
  });

  await t.test("cold rate-limit contention returns one session and an ordinary OTP rejection; fresh OTP recovers", async () => {
    await ops("revoke", memberA, "--confirm", memberA);
    await runtime.resetLimits();
    const otp = await runtime.sendOtp(emailA);
    const gate = await db.connect();
    let firstLogin!: Promise<Response>, secondLogin!: Promise<Response>;
    try {
      await gate.query("BEGIN");
      await gate.query("LOCK TABLE verification IN SHARE MODE");
      firstLogin = runtime.verify(emailA, otp);
      secondLogin = runtime.verify(emailA, otp);
      // Better Auth also serializes same-identifier consumption inside this worker.
      // Observe the database wait without assuming both requests reach DELETE together.
      await waitForBlocked('%delete from "verification"%');
      await gate.query("COMMIT");
      const responses = await Promise.all([firstLogin, secondLogin]);
      assert.deepEqual(responses.map(response => response.status).sort(), [200, 400]);
      const loser = responses.find(response => response.status === 400)!;
      assert.equal(loser.headers.getSetCookie().length, 0);
      assert.equal((await loser.json()).code, "INVALID_OTP");
      assert.equal((await db.query('SELECT count(*)::int AS n FROM session WHERE "userId"=$1', [userA])).rows[0].n, 1);
      cookieA = runtime.cookie(responses.find(response => response.status === 200)!);
      assert.equal((await request("/api/community", { cookie: cookieA })).status, 200);
      assert.equal((await runtime.verify(emailA, otp)).status, 400);
      assert.equal((await runtime.verify(emailA, otp)).status, 429, "Both concurrent attempts must count toward the unchanged limit");
      await runtime.resetLimits();
      cookieA = await runtime.login(emailA);
      assert.equal((await request("/api/community", { cookie: cookieA })).status, 200);
    } finally { await gate.query("ROLLBACK"); gate.release(); await Promise.allSettled([firstLogin, secondLogin].filter(Boolean)); }
  });

  await t.test("separate auth processes consume a first OTP once and enforce one shared cold rate limit", async t => {
    const first = await runtime.createAuthWorker();
    t.after(() => first.close());
    const second = await runtime.createAuthWorker();
    t.after(() => second.close());
    await runtime.resetLimits();
    const email = "acceptance-multiworker@example.test";
    const otp = await runtime.sendOtp(email);
    const gate = await db.connect();
    let attempts: ReturnType<typeof first.request>[] = [];
    try {
      await gate.query("BEGIN");
      await gate.query('LOCK TABLE "rateLimit" IN SHARE MODE');
      attempts = [first, second].map(worker => worker.request("verify", { email, otp }));
      // Both independently initialized handlers have reached the same database.
      await waitForBlocked('%INSERT INTO "rateLimit"%', 2);
      await gate.query("COMMIT");
      const results = await Promise.all(attempts);
      assert.deepEqual(results.map(result => result.status).sort(), [200, 400]);
      const loser = results.find(result => result.status === 400)!;
      assert.equal(loser.body.code, "INVALID_OTP");
      assert.equal(loser.cookies.length, 0);
      assert.equal((await db.query('SELECT count(*)::int AS n FROM session s JOIN "user" u ON u.id=s."userId" WHERE u.email=$1', [email])).rows[0].n, 1);
    } finally { await gate.query("ROLLBACK"); gate.release(); await Promise.allSettled(attempts); }

    const key = `synthetic-cold-${randomUUID()}`;
    const decisions = await Promise.all(Array.from({ length: 8 }, (_, index) =>
      (index % 2 ? first : second).request("consume", { key })));
    assert.equal(decisions.filter(result => result.allowed).length, 3);
    assert.ok(decisions.filter(result => !result.allowed).every(result => result.retryAfter! >= 1 && result.retryAfter! <= 60));
    const before = (await db.query('SELECT count, "lastRequest" FROM "rateLimit" WHERE key=$1', [key])).rows[0];
    assert.equal(before.count, 3);
    assert.equal((await first.request("consume", { key })).allowed, false);
    assert.deepEqual((await db.query('SELECT count, "lastRequest" FROM "rateLimit" WHERE key=$1', [key])).rows[0], before, "Denial must not extend the rolling window");
    await db.query('UPDATE "rateLimit" SET "lastRequest"="lastRequest"-61000 WHERE key=$1', [key]);
    assert.equal((await second.request("consume", { key })).allowed, true);
    assert.equal((await db.query('SELECT count FROM "rateLimit" WHERE key=$1', [key])).rows[0].count, 1);
  });

  await t.test("in-flight Better Auth session insert holds the control lock until commit; revoke waits then removes it", async () => {
    await runtime.resetLimits();
    const otp = await runtime.sendOtp(emailA);
    const gate = await db.connect();
    let login!: Promise<Response>, revoke!: ReturnType<typeof ops>;
    try {
      await gate.query("BEGIN");
      await gate.query("LOCK TABLE session IN SHARE MODE");
      const pid = (await gate.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      login = runtime.verify(emailA, otp);
      const sessionWait = await waitForBlocked('%insert into "session"%');
      assert.ok(sessionWait.some(row => row.blockers.includes(pid)));
      revoke = ops("revoke", memberA, "--confirm", memberA);
      const operatorWait = await waitForBlocked("%community_control%FOR UPDATE%");
      assert.ok(operatorWait.some(row => row.blockers.some(blocker => sessionWait.some(auth => auth.pid === blocker))), "Operator must wait for the exact Better Auth transaction");
      await gate.query("COMMIT");
      const issued = await login;
      assert.equal(issued.status, 200);
      await revoke;
      assert.equal((await request("/api/community", { cookie: runtime.cookie(issued) })).status, 401);
      assert.equal((await db.query('SELECT s.id FROM session s JOIN "user" u ON u.id=s."userId" WHERE u.email=$1', [emailA])).rowCount, 0);
    } finally { await gate.query("ROLLBACK"); gate.release(); await Promise.allSettled([login, revoke].filter(Boolean)); }
    await runtime.resetLimits();
    cookieA = await runtime.login(emailA);
  });

  await t.test("operator holding the exclusive control lock blocks authentication and prevents session resurrection", async () => {
    await runtime.resetLimits();
    const otp = await runtime.sendOtp(emailA);
    const gate = await db.connect();
    let block!: ReturnType<typeof ops>, login!: Promise<Response>;
    try {
      await gate.query("BEGIN");
      await gate.query("SELECT id FROM members WHERE id=$1 FOR UPDATE", [memberA]);
      const pid = (await gate.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      block = ops("block", memberA, "--confirm", memberA);
      const operatorWait = await waitForBlocked("%FOR UPDATE OF m, u%");
      assert.ok(operatorWait.some(row => row.blockers.includes(pid)));
      login = runtime.verify(emailA, otp);
      const authWait = await waitForBlocked("%community_control%FOR SHARE%");
      assert.ok(authWait.some(row => row.blockers.some(blocker => operatorWait.some(operator => operator.pid === blocker))));
      await gate.query("COMMIT");
      await block;
      const denied = await login;
      assert.equal(denied.status, 403);
      assert.equal((await denied.json()).code, "MEMBER_BLOCKED");
      assert.equal((await db.query('SELECT s.id FROM session s JOIN "user" u ON u.id=s."userId" WHERE u.email=$1', [emailA])).rowCount, 0);
      assert.equal((await request("/api/community", { cookie: cookieB })).status, 200);
    } finally { await gate.query("ROLLBACK"); gate.release(); await Promise.allSettled([block, login].filter(Boolean)); }
    await ops("unblock", memberA, "--confirm", memberA);
    assert.equal((await request("/api/community", { cookie: cookieA })).status, 401);
    await runtime.resetLimits();
    cookieA = await runtime.login(emailA);
  });

  await t.test("chat transaction commits before a waiting revoke and the next write is rejected", async () => {
    const gate = await db.connect();
    let write!: Promise<Response>, revoke!: ReturnType<typeof ops>;
    try {
      await gate.query("BEGIN");
      await gate.query("LOCK TABLE chat_messages IN SHARE MODE");
      const pid = (await gate.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      write = request("/api/chat", { cookie: cookieA, method: "POST", body: { body: "Abnahme vor Widerruf committen" } });
      const writing = await waitForBlocked("LOCK TABLE chat_messages IN SHARE ROW EXCLUSIVE MODE");
      assert.ok(writing.some(row => row.blockers.includes(pid)));
      revoke = ops("revoke", memberA, "--confirm", memberA);
      const waiting = await waitForBlocked("%community_control%FOR UPDATE%");
      assert.ok(waiting.some(row => row.blockers.some(blocker => writing.some(writer => writer.pid === blocker))));
      await gate.query("COMMIT");
      assert.equal((await write).status, 201);
      await revoke;
      assert.equal((await request("/api/chat", { cookie: cookieA, method: "POST", body: { body: "Abnahme unzulässig nach Widerruf" } })).status, 401);
      assert.equal((await db.query("SELECT id FROM chat_messages WHERE body='Abnahme unzulässig nach Widerruf'")).rowCount, 0);
    } finally { await gate.query("ROLLBACK"); gate.release(); await Promise.allSettled([write, revoke].filter(Boolean)); }
    await runtime.resetLimits();
    cookieA = await runtime.login(emailA);
  });

  for (const action of ["revoke", "block", "emergency", "delete"] as const) {
    await t.test(`late authenticated chat write after ${action} cannot publish; lifecycle and old invitations stay closed`, async () => {
      await runtime.resetLimits();
      const invitation = await invite(cookieA);
      const deletionRevision = (await json("/api/chat", cookieB)).data.revision;
      const otp = await runtime.sendOtp(emailA);
      const key = createHash("sha256").update(`content:${memberA}`).digest("hex");
      let bodyController!: ReadableStreamDefaultController<Uint8Array>;
      const stream = new ReadableStream<Uint8Array>({ start(controller) {
        bodyController = controller;
        controller.enqueue(new TextEncoder().encode('{"body":"'));
      } });
      const pending = fetch(runtime.origin + "/api/chat", {
        method: "POST", headers: { Cookie: cookieA, Origin: runtime.origin, "Content-Type": "application/json" },
        body: stream, duplex: "half", signal: AbortSignal.timeout(15000),
      } as RequestInit);
      const forbidden = `Abnahme verspätet ${action}`;
      try {
        let entered = false;
        for (let attempt = 0; attempt < 150; attempt++) {
          if ((await db.query("SELECT key FROM app_rate_limits WHERE key=$1", [key])).rowCount) { entered = true; break; }
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.ok(entered, "HTTP request must have passed its original actor check before the operator action");
        if (action === "emergency") await ops(action, "--confirm", action);
        else await ops(action, memberA, "--confirm", memberA);
      } finally {
        bodyController.enqueue(new TextEncoder().encode(`${forbidden}"}`)); bodyController.close();
      }
      const response = await pending;
      assert.equal(response.status, action === "emergency" ? 503 : action === "revoke" ? 401 : 403);
      assert.equal((await db.query("SELECT id FROM chat_messages WHERE body=$1", [forbidden])).rowCount, 0);
      assert.ok((await runtime.verify(emailA, otp)).status >= 400);
      assert.equal((await request("/api/community", { cookie: cookieA })).status, action === "emergency" ? 503 : 401);
      if (action === "block") {
        const send = await request("/api/auth/email-otp/send-verification-otp", { method: "POST", body: { email: emailA, type: "sign-in" } });
        assert.equal(send.status, 403);
        assert.equal((await send.json()).code, "MEMBER_BLOCKED");
        await ops("unblock", memberA, "--confirm", memberA);
      }
      if (action === "emergency") {
        const pause = await request("/api/chat", { cookie: cookieB });
        assert.equal(pause.status, 503);
        assert.equal((await pause.json()).code, "COMMUNITY_PAUSED");
        assert.equal((await db.query("SELECT id FROM session")).rowCount, 0);
        assert.equal((await db.query("SELECT id FROM verification")).rowCount, 0);
        await ops("resume", "--confirm", "resume");
        assert.equal((await request("/api/community", { cookie: cookieB })).status, 401);
        await runtime.resetLimits();
        cookieB = await runtime.login(emailB);
      }
      assert.equal((await request("/api/community", { cookie: cookieA })).status, 401);
      await runtime.resetLimits();
      cookieA = await runtime.login(emailA);
      assert.equal((await request("/api/community", { cookie: cookieA })).status, action === "delete" ? 403 : 200);
      // A currently valid nonmember session proves the invitation itself was revoked.
      const currentApplicant = await runtime.login("acceptance-applicant@example.test");
      assert.equal((await join(currentApplicant, invitation, "Rival")).status, 400);
      if (action === "delete") {
        for (const [table, column] of [["user", "id"], ["session", "userId"], ["account", "userId"]]) {
          assert.equal((await db.query(`SELECT id FROM "${table}" WHERE "${column}"=$1`, [userA])).rowCount, 0);
        }
        for (const table of ["members", "comments", "chat_messages"]) {
          const column = table === "members" ? "id" : "author_id";
          assert.equal((await db.query(`SELECT id FROM ${table} WHERE ${column}=$1`, [memberA])).rowCount, 0);
        }
        const feed = (await json("/api/community", cookieB)).data;
        const tombstone = feed.posts.find((post: { deleted: boolean }) => post.deleted);
        assert.ok(tombstone);
        assert.equal(tombstone.authorId, null);
        assert.equal(tombstone.body, "");
        assert.equal(tombstone.comments[0].body, "Abnahme Bob Antwort bleibt");
        const chat = (await json("/api/chat", cookieB)).data;
        assert.notEqual(chat.revision, deletionRevision);
        assert.ok(chat.messages.every((message: { authorId: string }) => message.authorId === memberB));
        assert.ok(chat.messages.some((message: { body: string }) => message.body === "Abnahme Bob Chat bleibt"));
      }
    });
  }
});
