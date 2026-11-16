import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import { appOrigin, authConfig, databaseUrl } from "../src/lib/config";
import { readJson, contentSchema, clientBucket } from "../src/lib/security";
import { ApiError } from "../src/lib/errors";

function status(code: number) { return (error: unknown) => error instanceof ApiError && error.status === code; }

test("strict bounded JSON, controls and slow bodies", async () => {
  const req = (body: string, type = "application/json") => new Request("https://community.example/api/posts", { method: "POST", headers: { "Content-Type": type }, body });
  await assert.rejects(readJson(req('{"body":"test"}', "application/jsonp"), contentSchema), status(415));
  await assert.rejects(readJson(req('{'), contentSchema), status(400));
  await assert.rejects(readJson(req(JSON.stringify({ body: "x".repeat(25000) })), contentSchema), status(413));
  await assert.rejects(readJson(req(JSON.stringify({ body: "x".repeat(5001) })), contentSchema), status(400));
  await assert.rejects(readJson(req(JSON.stringify({ body: "hello\u0000" })), contentSchema), status(400));
  await assert.rejects(readJson(req(JSON.stringify({ body: "hello", authorId: "forged" })), contentSchema), status(400));
  assert.deepEqual(await readJson(req('{"body":"line 1\\nline 2"}', "application/json; charset=utf-8"), contentSchema), { body: "line 1\nline 2" });
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('{"body":"partial')); } });
  const slow = new Request("https://community.example", { method: "POST", headers: { "Content-Type": "application/json" }, body: stream, duplex: "half" } as RequestInit);
  await assert.rejects(readJson(slow, contentSchema), status(408));
});

test("production configuration fails closed and proxy identity cannot be spoofed off Vercel", () => {
  const previous = { ...process.env };
  try {
    Object.assign(process.env, { NODE_ENV: "production", BETTER_AUTH_URL: "http://localhost:3000", DATABASE_URL: "postgresql://user:synthetic@db.example/db?sslmode=verify-full", BETTER_AUTH_SECRET: randomBytes(48).toString("hex"), SMTP_HOST: "smtp.example", SMTP_FROM: "test@example.test", SMTP_USER: "test", SMTP_PASS: "synthetic" });
    assert.throws(appOrigin, status(503));
    process.env.BETTER_AUTH_URL = "https://community.example";
    assert.equal(appOrigin(), "https://community.example");
    for (const url of ["https://user:pass@community.example", "https://community.example/api", "https://community.example?secret=x"]) {
      process.env.BETTER_AUTH_URL = url;
      assert.throws(appOrigin, status(503));
    }
    process.env.BETTER_AUTH_URL = "https://community.example";
    assert.equal(authConfig().baseURL, "https://community.example");
    process.env.BETTER_AUTH_SECRET = "replace-with-a-random-secret-at-least-32-characters";
    assert.throws(authConfig, status(503));
    assert.match(databaseUrl(), /verify-full/);
    process.env.DATABASE_URL = "postgresql://user:synthetic@db.example/db?sslmode=no-verify";
    assert.throws(databaseUrl, status(503));
    process.env.DATABASE_URL = "postgresql://user:synthetic@db.example/db?sslmode=verify-full&ssl=false";
    assert.throws(databaseUrl, status(503));
    for (const mode of ["disable", "no-verify"]) {
      process.env.DATABASE_URL = `postgresql://user:synthetic@db.example/db?sslmode=verify-full&sslmode=${mode}`;
      assert.throws(databaseUrl, status(503));
    }
    delete process.env.VERCEL;
    const request = (ip: string) => new Request("https://community.example", { headers: { "x-vercel-forwarded-for": ip, "x-forwarded-for": "198.51.100.1" } });
    assert.equal(clientBucket(request("192.0.2.1")), "shared");
    process.env.VERCEL = "1";
    assert.equal(clientBucket(request("192.0.2.1")), "192.0.2.1");
    assert.equal(clientBucket(request("192.0.2.1, 192.0.2.2")), "shared");
    assert.equal(clientBucket(request("2001:db8::1")), clientBucket(request("2001:0db8:0:0:abcd::2")));
    assert.equal(clientBucket(request("::ffff:192.0.2.1")), "192.0.2.1");
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  }
});

test("operator connections reject TLS bypasses and remote development URLs", async () => {
  const { operatorDatabaseUrl } = await import("../scripts/operator-config");
  const previous = { ...process.env };
  try {
    Object.assign(process.env, { NODE_ENV: "test" });
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    for (const value of [
      "postgresql://user:synthetic@db.example/community",
      "postgresql://user:synthetic@db.example/community?sslmode=require",
      "postgresql://user:synthetic@db.example/community?sslmode=verify-full&sslmode=disable",
      "postgresql://user:synthetic@db.example/community?sslmode=verify-full&ssl=false",
      "postgresql://user:synthetic@localhost/community?host=db.example",
      "postgresql://user:synthetic@localhost/community?sslmode=no-verify",
    ]) {
      process.env.DATABASE_URL = value;
      assert.throws(operatorDatabaseUrl);
    }
    process.env.DATABASE_URL = "postgresql://user:synthetic@127.0.0.1/community";
    assert.equal(operatorDatabaseUrl(), process.env.DATABASE_URL);
    Object.assign(process.env, { NODE_ENV: "production" });
    assert.throws(operatorDatabaseUrl);
    process.env.DATABASE_URL = "postgresql://user:synthetic@db.example/community?sslmode=verify-full";
    assert.equal(operatorDatabaseUrl(), process.env.DATABASE_URL);
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    assert.throws(operatorDatabaseUrl);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  }
});
