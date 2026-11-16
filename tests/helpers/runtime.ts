import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { SMTPServer } from "smtp-server";
import { createServer } from "node:net";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port allocated");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

export async function testRuntime() {
  // Explicit assets also support workspace paths containing a literal #.
  const asset = (name: string) => readFile(`node_modules/@electric-sql/pglite/dist/${name}`);
  const db = await PGlite.create({
    fsBundle: new Blob([new Uint8Array(await asset("pglite.data"))]),
    pgliteWasmModule: await WebAssembly.compile(new Uint8Array(await asset("pglite.wasm"))),
    initdbWasmModule: await WebAssembly.compile(new Uint8Array(await asset("initdb.wasm"))),
  });
  const pg = new PGLiteSocketServer({ db, host: "127.0.0.1", port: await freePort(), maxConnections: 20 });
  await pg.start();
  const databaseUrl = `postgresql://postgres:postgres@${pg.getServerConn()}/postgres`;
  // Exercise the actual deployment migration command, including idempotent reruns.
  try {
    for (let run = 0; run < 2; run++) {
      await promisify(execFile)(process.execPath, ["--import", "tsx", "scripts/migrate.ts"], {
        env: { ...process.env, DATABASE_URL: databaseUrl }, timeout: 20000,
      });
    }
  } catch (error) { await pg.stop(); await db.close(); throw error; }
  const messages = new Map<string, string>();
  const cookieAttributes = new Map<string, string[]>();
  const smtpPort = await freePort();
  const smtp = new SMTPServer({
    authOptional: true, disabledCommands: ["STARTTLS", "AUTH"],
    onData(stream, session, callback) {
      let message = "";
      stream.on("data", (chunk) => { message += chunk.toString(); });
      stream.on("end", () => {
        for (const recipient of session.envelope.rcptTo) messages.set(recipient.address, message);
        callback();
      });
    },
  });
  await new Promise<void>((resolve) => smtp.listen(smtpPort, "127.0.0.1", resolve));
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  let logs = "";
  const app = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--hostname", "127.0.0.1", "--port", String(port)], {
    env: {
      ...process.env, NODE_ENV: "development", NEXT_TELEMETRY_DISABLED: "1",
      DATABASE_URL: databaseUrl, BETTER_AUTH_URL: origin,
      BETTER_AUTH_SECRET: randomBytes(48).toString("hex"),
      SMTP_HOST: "127.0.0.1", SMTP_PORT: String(smtpPort), SMTP_SECURE: "false",
      SMTP_ALLOW_INSECURE: "true", SMTP_USER: "", SMTP_PASS: "", SMTP_FROM: "test@example.test",
    }, stdio: ["ignore", "pipe", "pipe"],
  });
  app.stdout.on("data", (chunk) => { logs = (logs + chunk.toString()).slice(-12000); });
  app.stderr.on("data", (chunk) => { logs = (logs + chunk.toString()).slice(-12000); });
  async function close() {
    app.kill("SIGTERM");
    await new Promise<void>((resolve) => { if (app.exitCode !== null) resolve(); else app.once("exit", () => resolve()); });
    await new Promise<void>((resolve) => smtp.close(resolve));
    await pg.stop();
    await db.close();
  }
  try {
    let ready = false;
    for (let i = 0; i < 90; i++) {
      try { const response = await fetch(`${origin}/api/auth/get-session`); if (response.ok) { ready = true; break; } } catch { /* startup */ }
      if (app.exitCode !== null) throw new Error("App exited during startup");
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (!ready) throw new Error(`App did not start: ${logs}`);
  } catch (error) { await close(); throw error; }
  async function bootstrapInvite() {
    const token = randomBytes(32).toString("base64url");
    await db.query("INSERT INTO invitations (id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 day')", [randomUUID(), createHash("sha256").update(token).digest("hex")]);
    return token;
  }
  async function login(email: string) {
    const send = await fetch(`${origin}/api/auth/email-otp/send-verification-otp`, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify({ email, type: "sign-in" }) });
    if (!send.ok) throw new Error(`OTP send ${send.status}: ${await send.text()}`);
    const otp = messages.get(email)?.match(/\b\d{6}\b/)?.[0];
    if (!otp) throw new Error("No OTP captured");
    const response = await fetch(`${origin}/api/auth/sign-in/email-otp`, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify({ email, otp }) });
    if (!response.ok) throw new Error(`OTP login ${response.status}: ${await response.text()}`);
    cookieAttributes.set(email, response.headers.getSetCookie());
    return response.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
  }
  return { db, databaseUrl, origin, close, login, bootstrapInvite, cookieAttributesFor: (email: string) => cookieAttributes.get(email), otpFor: (email: string) => messages.get(email)?.match(/\b\d{6}\b/)?.[0], logs: () => logs };
}
