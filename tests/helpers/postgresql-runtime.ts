import assert from "node:assert/strict";
import { Pool } from "pg";
import { SMTPServer } from "smtp-server";
import { createServer } from "node:net";
import { spawn, execFile, fork } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { readdir } from "node:fs/promises";

const exec = promisify(execFile);
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function freePort() {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>(resolve => server.close(() => resolve()));
  return address.port;
}

// Explicit opt-in; never use DATABASE_URL or a project's real environment files.
export async function postgresqlRuntime() {
  const databaseUrl = process.env.KIMA_ACCEPTANCE_DATABASE_URL;
  assert.ok(databaseUrl, "Set KIMA_ACCEPTANCE_DATABASE_URL to an empty isolated PostgreSQL database");
  const destination = new URL(databaseUrl);
  assert.equal(destination.hostname, "127.0.0.1", "Only local loopback fixtures are accepted");
  assert.match(destination.pathname, /^\/kima_acceptance[a-z0-9_]*$/);
  assert.equal(destination.search, "", "Connection overrides are forbidden for this local fixture");
  assert.ok(!(await readdir(process.cwd())).some(name => /^\.env($|\.)/.test(name) && name !== ".env.example"), "Use an isolated copy without environment files");
  assert.ok(!(await readdir(".next/dev").catch((): string[] => [])).includes("lock"), "Do not share a running preview's build directory");
  const db = new Pool({ connectionString: databaseUrl, max: 8, statement_timeout: 15000 });
  try {
    const version = await db.query("SELECT current_setting('server_version_num')::int AS version");
    assert.ok(version.rows[0].version >= 180000, "Real PostgreSQL 18 or later required");
    assert.equal((await db.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")).rowCount, 0, "Refusing a nonempty database");
    for (let run = 0; run < 2; run++) {
      await exec(process.execPath, ["--import", "tsx", "scripts/migrate.ts"], { env: { ...process.env, DATABASE_URL: databaseUrl }, timeout: 30000 });
    }
  } catch (error) { await db.end(); throw error; }
  const messages = new Map<string, string>();
  const smtp = new SMTPServer({
    authOptional: true, disabledCommands: ["AUTH", "STARTTLS"],
    onRcptTo(address, _session, callback) {
      callback(address.address.endsWith("@example.test") ? undefined : new Error("Synthetic recipients only"));
    },
    onData(stream, session, callback) {
      let message = "";
      stream.on("data", chunk => { message += chunk.toString(); });
      stream.on("end", () => {
        for (const recipient of session.envelope.rcptTo) messages.set(recipient.address, message);
        callback();
      });
    },
  });
  const smtpPort = await freePort();
  await new Promise<void>(resolve => smtp.listen(smtpPort, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${await freePort()}`;
  let logs = "";
  const appEnv: NodeJS.ProcessEnv = {
    ...process.env, NODE_ENV: "development", NEXT_TELEMETRY_DISABLED: "1", VERCEL: "",
    DATABASE_URL: databaseUrl, BETTER_AUTH_URL: origin, BETTER_AUTH_SECRET: randomBytes(48).toString("hex"),
    SMTP_HOST: "127.0.0.1", SMTP_PORT: String(smtpPort), SMTP_SECURE: "false", SMTP_ALLOW_INSECURE: "true",
    SMTP_USER: "", SMTP_PASS: "", SMTP_FROM: "acceptance@example.test",
  };
  const app = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--hostname", "127.0.0.1", "--port", new URL(origin).port], {
    env: appEnv, stdio: ["ignore", "pipe", "pipe"],
  });
  app.stdout.on("data", chunk => { logs = (logs + chunk.toString()).slice(-12000); });
  app.stderr.on("data", chunk => { logs = (logs + chunk.toString()).slice(-12000); });
  async function close() {
    app.kill("SIGTERM");
    await new Promise<void>(resolve => { if (app.exitCode !== null) resolve(); else app.once("exit", () => resolve()); });
    await new Promise<void>(resolve => smtp.close(resolve));
    await db.end();
  }
  async function request(path: string, options: { cookie?: string; method?: string; body?: unknown } = {}) {
    return fetch(origin + path, {
      method: options.method ?? "GET", headers: { "Content-Type": "application/json", Origin: origin, ...(options.cookie ? { Cookie: options.cookie } : {}) },
      body: options.body === undefined ? undefined : JSON.stringify(options.body), signal: AbortSignal.timeout(20000),
    });
  }
  async function sendOtp(email: string) {
    messages.delete(email);
    const response = await request("/api/auth/email-otp/send-verification-otp", { method: "POST", body: { email, type: "sign-in" } });
    assert.equal(response.status, 200, `OTP request failed (${response.status})`);
    const otp = messages.get(email)?.match(/\b\d{6}\b/)?.[0];
    assert.ok(otp, "Local SMTP must have received an OTP");
    return otp;
  }
  async function verify(email: string, otp: string) {
    return request("/api/auth/sign-in/email-otp", { method: "POST", body: { email, otp } });
  }
  function cookie(response: Response) {
    return response.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
  }
  async function login(email: string) {
    const response = await verify(email, await sendOtp(email));
    assert.equal(response.status, 200, `OTP verification failed (${response.status})`);
    return cookie(response);
  }
  async function resetLimits() { await db.query('DELETE FROM app_rate_limits; DELETE FROM "rateLimit"'); }
  async function ops(...args: string[]) {
    const result = await exec(process.execPath, ["--import", "tsx", "scripts/operator.ts", ...args], {
      env: { ...process.env, DATABASE_URL: databaseUrl, NODE_ENV: "test" }, timeout: 20000,
    });
    return JSON.parse(result.stdout);
  }
  async function waitForBlocked(queryPattern: string, count = 1) {
    for (let attempt = 0; attempt < 200; attempt++) {
      const result = await db.query<{ pid: number; blockers: number[] }>(`SELECT pid, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid() AND state = 'active'
        AND wait_event_type = 'Lock' AND query LIKE $1`, [queryPattern]);
      if (result.rows.length >= count) return result.rows;
      await delay(20);
    }
    throw new Error(`Expected ${count} real PostgreSQL lock wait(s) for ${queryPattern}`);
  }
  async function createAuthWorker() {
    const worker = fork("tests/helpers/auth-worker.ts", [], { env: appEnv, execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "ignore", "ipc"] });
    let sequence = 0;
    type WorkerResult = { status: number; cookies: string[]; body: { code?: string }; allowed: boolean; retryAfter: number | null };
    const pending = new Map<number, { resolve: (result: WorkerResult) => void; reject: (error: Error) => void }>();
    worker.on("message", (message: { id?: number; result: WorkerResult; error?: string }) => {
      if (message.id === undefined) return;
      const request = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) request?.reject(new Error(message.error));
      else request?.resolve(message.result);
    });
    worker.on("exit", () => { for (const request of pending.values()) request.reject(new Error("Synthetic worker exited")); pending.clear(); });
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => { worker.kill(); reject(new Error("Synthetic worker startup timed out")); }, 15000);
        worker.once("message", () => { clearTimeout(timeout); resolve(); });
        worker.once("exit", () => { clearTimeout(timeout); reject(new Error("Synthetic worker startup failed")); });
      });
    } catch (error) { worker.kill(); throw error; }
    return {
      request(action: "verify" | "consume", data: { email?: string; otp?: string; key?: string }) {
        return new Promise<WorkerResult>((resolve, reject) => {
          const id = ++sequence;
          const timeout = setTimeout(() => { pending.delete(id); reject(new Error("Synthetic worker request timed out")); }, 20000);
          pending.set(id, { resolve: result => { clearTimeout(timeout); resolve(result); }, reject: error => { clearTimeout(timeout); reject(error); } });
          worker.send({ id, action, ...data });
        });
      },
      async close() {
        worker.kill();
        await new Promise<void>(resolve => { if (worker.exitCode !== null || worker.signalCode !== null) resolve(); else worker.once("exit", () => resolve()); });
      },
    };
  }
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { if ((await request("/api/auth/get-session")).ok) { ready = true; break; } } catch { /* server startup */ }
      if (app.exitCode !== null) throw new Error("Isolated app exited");
      await delay(400);
    }
    assert.ok(ready, `Isolated server failed to start: ${logs}`);
  } catch (error) { await close(); throw error; }
  return { db, origin, close, request, sendOtp, verify, cookie, login, resetLimits, ops, waitForBlocked, createAuthWorker, logs: () => logs };
}
