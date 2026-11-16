import assert from "node:assert/strict";
import { test } from "node:test";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { Pool } from "pg";

const exec = promisify(execFile);
const delay = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));

// Explicit opt-in. Creates its own empty, password-protected loopback PG18
// cluster; never reads .env files, uses production, sends mail or starts Next.
test("PostgreSQL 18: concurrent resume reads and pool recovery", { timeout: 90000 }, async t => {
  const bin = process.env.KIMA_TEST_POSTGRES_BIN;
  assert.ok(bin, "Set KIMA_TEST_POSTGRES_BIN to a PostgreSQL 18 bin directory");
  const folder = await mkdtemp(join(tmpdir(), "kima-resume-pg-"));
  const cleanup: { server?: ReturnType<typeof spawn>; admin?: Pool; applicationPool?: Pool } = {};
  t.after(async () => {
    await cleanup.applicationPool?.end();
    await cleanup.admin?.end();
    const server = cleanup.server;
    if (server) {
      server.kill("SIGTERM");
      await new Promise<void>(resolve => {
        if (server.exitCode !== null || server.signalCode !== null) resolve();
        else server.once("exit", () => resolve());
      });
    }
    await rm(folder, { recursive: true, force: true });
  });
  const password = randomBytes(32).toString("hex");
  await writeFile(join(folder, "password"), password, { mode: 0o600 });
  await exec(join(bin, "initdb"), ["-D", join(folder, "data"), "-U", "fixture", "-A", "scram-sha-256", "--pwfile", join(folder, "password"), "--no-locale", "-E", "UTF8"]);
  const socket = createServer();
  await new Promise<void>(resolve => socket.listen(0, "127.0.0.1", resolve));
  const address = socket.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>(resolve => socket.close(() => resolve()));
  cleanup.server = spawn(join(bin, "postgres"), ["-D", join(folder, "data"), "-h", "127.0.0.1", "-p", String(port), "-c", "unix_socket_directories="], { stdio: "ignore" });
  const url = `postgresql://fixture:${password}@127.0.0.1:${port}/postgres`;
  const admin = cleanup.admin = new Pool({ connectionString: url, max: 2, connectionTimeoutMillis: 1000 });
  for (let attempt = 0; ; attempt++) {
    try { await admin.query("SELECT 1"); break; }
    catch { if (attempt >= 50) throw new Error("Isolated PostgreSQL startup failed"); await delay(100); }
  }
  assert.ok((await admin.query("SHOW server_version_num")).rows[0].server_version_num >= 180000);
  assert.equal((await admin.query("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rowCount, 0);
  for (const file of (await readdir("migrations")).filter(name => /^\d+.*\.sql$/.test(name)).sort()) {
    await admin.query(await readFile(join("migrations", file), "utf8"));
  }
  const secret = randomBytes(48).toString("hex");
  Object.assign(process.env, {
    NODE_ENV: "test", VERCEL: "", DATABASE_URL: url, BETTER_AUTH_URL: "http://127.0.0.1:39999",
    BETTER_AUTH_SECRET: secret, SMTP_HOST: "127.0.0.1", SMTP_PORT: "1", SMTP_FROM: "fixture@example.test",
    SMTP_ALLOW_INSECURE: "true", SMTP_USER: "", SMTP_PASS: "",
  });
  const { database } = await import("../src/lib/db");
  const { GET: session } = await import("../src/app/api/auth/[...all]/route");
  const { GET: feed } = await import("../src/app/api/community/route");
  const { GET: chat } = await import("../src/app/api/chat/route");
  const pool = cleanup.applicationPool = database();
  assert.equal(pool.options.max, 3);
  const userId = randomUUID(), memberId = randomUUID(), sessionId = randomUUID(), token = randomBytes(32).toString("hex");
  await admin.query('INSERT INTO "user" (id,name,email,"emailVerified") VALUES ($1,$2,$3,true)', [userId, "Synthetic Resume", "resume@example.test"]);
  await admin.query("INSERT INTO members (id,user_id,first_name,last_name) VALUES ($1,$2,'Synthetic','Resume')", [memberId, userId]);
  await admin.query('INSERT INTO session (id,token,"userId","expiresAt") VALUES ($1,$2,$3,now()+interval \'7 days\')', [sessionId, token, userId]);
  const cookie = `better-auth.session_token=${encodeURIComponent(`${token}.${createHmac("sha256", secret).update(token).digest("base64")}`)}`;
  const cases = [["/api/auth/get-session", session], ["/api/community", feed], ["/api/chat", chat]] as const;
  async function request(index: number) {
    const [path, handler] = cases[index % cases.length];
    const started = performance.now();
    const response = await handler(new Request(process.env.BETTER_AUTH_URL + path, { headers: { Cookie: cookie } }));
    const data = await response.json();
    if (response.status === 200) {
      if (path.endsWith("get-session")) assert.equal(data.user.id, userId);
      if (path === "/api/community") assert.equal(data.member.id, memberId);
      if (path === "/api/chat") assert.ok(Array.isArray(data.messages));
    }
    return { status: response.status, milliseconds: Math.round(performance.now() - started) };
  }
  async function resetLimits() { await admin.query('DELETE FROM app_rate_limits; DELETE FROM "rateLimit"'); }
  async function batch(count: number) {
    await resetLimits();
    const results = await Promise.all(Array.from({ length: count }, (_, index) => request(index)));
    assert.ok(results.every(result => result.status === 200), JSON.stringify(results));
    assert.equal(pool.waitingCount, 0);
    assert.equal(pool.idleCount, pool.totalCount);
    t.diagnostic(`${count} concurrent requests: maximum ${Math.max(...results.map(result => result.milliseconds))} ms; ${pool.totalCount} idle clients`);
  }
  await t.test("session, feed and chat share three clients without nested-acquisition deadlock", async () => {
    await batch(3);
    await batch(36);
  });
  await t.test("concurrent stale sessions renew without holding or leaking the pool", async () => {
    await admin.query('UPDATE session SET "updatedAt"=now()-interval \'2 days\', "expiresAt"=now()+interval \'5 days\' WHERE id=$1', [sessionId]);
    await batch(30);
    assert.ok((await admin.query('SELECT "expiresAt" > now()+interval \'6 days\' AS renewed FROM session WHERE id=$1', [sessionId])).rows[0].renewed);
  });
  await t.test("idle connection loss is removed and subsequent reads reconnect", async () => {
    const clients = await Promise.all([pool.connect(), pool.connect(), pool.connect()]);
    const pids = await Promise.all(clients.map(async client => (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid));
    clients.forEach(client => client.release());
    await admin.query("SELECT pg_terminate_backend(pid) FROM unnest($1::int[]) AS pid", [pids]);
    for (let attempt = 0; pool.totalCount > 0 && attempt < 100; attempt++) await delay(10);
    assert.equal(pool.totalCount, 0);
    await batch(9);
  });
  await t.test("exhausted pool fails within its acquire timeout then recovers", async () => {
    await resetLimits();
    const clients = await Promise.all([pool.connect(), pool.connect(), pool.connect()]);
    try {
      const results = await Promise.all([request(0), request(1), request(2)]);
      assert.ok(results.every(result => result.status === 503 && result.milliseconds >= 7500 && result.milliseconds < 12000), JSON.stringify(results));
      assert.equal(pool.waitingCount, 0);
      t.diagnostic(`Acquire timeouts: ${results.map(result => result.milliseconds).join(", ")} ms`);
    } finally { clients.forEach(client => client.release()); }
    await batch(3);
  });
  await t.test("server-side statement timeout releases auth transaction and later reads recover", async () => {
    await resetLimits();
    const gate = await admin.connect();
    try {
      await gate.query("BEGIN");
      await gate.query('LOCK TABLE session IN ACCESS EXCLUSIVE MODE');
      const results = await Promise.all([request(0), request(1), request(2)]);
      assert.ok(results.every(result => result.status >= 500 && result.milliseconds >= 9500 && result.milliseconds < 14000), JSON.stringify(results));
      assert.equal(pool.waitingCount, 0);
      assert.equal(pool.idleCount, pool.totalCount);
      t.diagnostic(`Statement timeouts: ${results.map(result => result.milliseconds).join(", ")} ms`);
    } finally { await gate.query("ROLLBACK"); gate.release(); }
    await batch(3);
  });
});
