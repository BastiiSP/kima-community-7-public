import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { databaseUrl, loadConfig, postgresEnvironment, readPrivate } from "../scripts/backup-config";
import { decryptBundle, encryptStream, lockDirectory, newHeader, publishBundle, retainBundles, stale, writePrivate } from "../scripts/backup-storage";
import { allowedSourceFile } from "../scripts/backup-source";
import { parseArguments, runBackupCli } from "../scripts/backup";
import { validateLedger } from "../scripts/backup-restore";

async function temporary(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(await realpath(tmpdir()), "kima-backup-test-"));
  await chmod(dir, 0o700);
  try { await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

const source = "postgresql://owner:synthetic-password@example.test/kima?sslmode=verify-full";

test("backup source requires direct verified TLS; restore rejects remote, override queries and wrong databases", () => {
  assert.equal(databaseUrl(source, "source").hostname, "example.test");
  for (const url of [source.replace("verify-full", "require"), source.replace("example.test", "ep-pooler.example.test"), `${source}&host=127.0.0.1`, `${source}&sslmode=disable`, `${source}#fragment`]) assert.throws(() => databaseUrl(url, "source"));
  for (const url of [source, "postgresql://u@localhost/kima_restore_test?sslmode=disable", "postgresql://u@127.0.0.1/production?sslmode=disable", "postgresql://u@127.0.0.1/kima_restore_test?sslmode=prefer", "postgresql://u@127.0.0.1/kima_restore_test?sslmode=disable&options=x"]) assert.throws(() => databaseUrl(url, "restore"));
  const local = databaseUrl("postgresql://u:p@127.0.0.1:55438/kima_restore_test?sslmode=disable", "restore");
  const env = postgresEnvironment(local, "/bin");
  assert.equal(env.PGSSLROOTCERT, undefined);
  assert.equal(env.PGPASSFILE, "/dev/null");
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(postgresEnvironment(databaseUrl(source, "source"), "/bin").PGSSLROOTCERT, "system");
});

test("CLI accepts only exact commands and explicit restore confirmation", () => {
  assert.equal(parseArguments(["backup", "--config", "/private/config"]).command, "backup");
  for (const args of [[], ["backup"], ["backup", "--config", "x", "--config", "x"], ["restore", "--config", "x", "--id", "one", "--confirm", "other"], ["backup", "--config", "x", "--id", "one"]]) assert.throws(() => parseArguments(args));
});

test("private file validation rejects readable files and symlink leaves or ancestors", async () => temporary(async dir => {
  const file = path.join(dir, "secret");
  await writePrivate(file, "synthetic");
  assert.equal((await readPrivate(file)).toString(), "synthetic");
  await chmod(file, 0o644);
  await assert.rejects(readPrivate(file));
  await chmod(file, 0o600);
  const link = path.join(dir, "link");
  await symlink(file, link);
  await assert.rejects(readPrivate(link));
  await symlink(dir, path.join(dir, "parent"));
  await assert.rejects(readPrivate(path.join(dir, "parent", "secret")));
}));

test("encrypted bundle is atomic, round-trips, rejects wrong keys and removes unauthenticated plaintext", async () => temporary(async dir => {
  const key = randomBytes(32), payload = randomBytes(256 * 1024), header = newHeader("database");
  await publishBundle(dir, header, file => encryptStream(Readable.from([payload]), file, key, header));
  const encrypted = path.join(dir, header.id, "payload.enc");
  assert.equal((await stat(encrypted)).mode & 0o777, 0o600);
  assert.equal((await stat(path.dirname(encrypted))).mode & 0o777, 0o700);
  assert.notDeepEqual(await readFile(encrypted), payload);
  const output = path.join(dir, "authenticated.dump");
  await decryptBundle(dir, header.id, key, output);
  assert.deepEqual(await readFile(output), payload);
  const rejected = path.join(dir, "rejected.dump");
  await assert.rejects(decryptBundle(dir, header.id, randomBytes(32), rejected));
  await assert.rejects(stat(rejected));
  const bytes = await readFile(encrypted); bytes[100] ^= 1; await writeFile(encrypted, bytes);
  await assert.rejects(decryptBundle(dir, header.id, key, rejected));
  await assert.rejects(stat(rejected));
}));

test("manifest metadata is authenticated and failed publication leaves no completed bundle", async () => temporary(async dir => {
  const key = randomBytes(32), header = newHeader("database");
  await assert.rejects(publishBundle(dir, header, async () => { throw new Error("synthetic failure"); }));
  assert.deepEqual(await readdir(dir), []);
  await publishBundle(dir, header, file => encryptStream(Readable.from([Buffer.from("safe-test")]), file, key, header));
  const file = path.join(dir, header.id, "manifest.json");
  const manifest = JSON.parse(await readFile(file, "utf8"));
  manifest.header.startedAt = new Date(Date.now() - 86400_000).toISOString();
  await writeFile(file, JSON.stringify(manifest));
  await assert.rejects(decryptBundle(dir, header.id, key));
}));

test("lock rejects concurrent work and releases after a failure", async () => temporary(async dir => {
  await lockDirectory(dir, async () => { await assert.rejects(lockDirectory(dir, async () => true)); });
  await assert.rejects(lockDirectory(dir, async () => { throw new Error("failure"); }));
  assert.deepEqual(await readdir(dir), []);
}));

test("retention expires authenticated bundles after seven days, preserving unknown files", async () => temporary(async dir => {
  const key = randomBytes(32), old = { ...newHeader("database"), startedAt: new Date(Date.now() - 8 * 86400_000).toISOString() }, fresh = newHeader("database");
  for (const header of [old, fresh]) await publishBundle(dir, header, file => encryptStream(Readable.from([Buffer.from("fixture")]), file, key, header));
  await writePrivate(path.join(dir, "operator-note"), "retain");
  assert.equal(stale(await decryptBundle(dir, old.id, key)), true);
  assert.equal(stale(await decryptBundle(dir, fresh.id, key)), false);
  await retainBundles(dir, key, 7);
  assert.deepEqual((await readdir(dir)).sort(), [fresh.id, "operator-note"].sort());
}));

test("source allowlist excludes environment, output, credentials and path traversal", () => {
  for (const value of ["src/app/page.tsx", "scripts/backup.ts", "scripts/backup-storage.ts", ".github/workflows/backup.yml", "migrations/004_human_community_chat.sql", "package-lock.json"]) assert.equal(allowedSourceFile(value), true, value);
  for (const value of [".env.local", "src/.env.ts", "src/../secret.ts", "docs/technik.md", "Ergebnisse/export.json", "public/members.json", "scripts/credentials.ts", "backups/dump.sql"]) assert.equal(allowedSourceFile(value), false, value);
});

test("recovery ledger requires complete recent review tied to exactly this snapshot", () => {
  const header = newHeader("database");
  const ledger = { format: 1, backupId: header.id, backupStartedAt: header.startedAt, reviewedThrough: new Date().toISOString(), complete: true, blockedMemberIds: [], deletedMemberIds: [], deletedPostIds: [], deletedCommentIds: [], deletedChatMessageIds: [] };
  assert.equal(validateLedger(ledger, header).complete, true);
  for (const value of [{ ...ledger, complete: false }, { ...ledger, backupId: "other" }, { ...ledger, reviewedThrough: new Date(Date.now() - 7200_000).toISOString() }, { ...ledger, deletedChatMessageIds: undefined }]) assert.throws(() => validateLedger(value, header));
});

test("historical offline ledger accepts age only while retaining identity, order and schema checks", () => {
  const now = Date.parse("2026-11-18T12:00:00.000Z");
  const backup = { id: "database-historical-fixture", startedAt: "2026-11-16T10:00:00.000Z" };
  const ledger = { format: 1, backupId: backup.id, backupStartedAt: backup.startedAt,
    reviewedThrough: "2026-11-16T10:05:00.000Z", complete: true,
    blockedMemberIds: [], deletedMemberIds: [], deletedPostIds: [], deletedCommentIds: [], deletedChatMessageIds: [] };
  assert.throws(() => validateLedger(ledger, backup, now));
  assert.equal(validateLedger(ledger, backup, now, "historical-offline").reviewedThrough, ledger.reviewedThrough);
  for (const invalid of [
    { ...ledger, backupId: "wrong" }, { ...ledger, backupStartedAt: "2026-11-16T09:59:00.000Z" },
    { ...ledger, reviewedThrough: "2026-11-16T09:59:00.000Z" },
    { ...ledger, reviewedThrough: "2026-11-18T12:01:01.000Z" },
    { ...ledger, complete: false }, { ...ledger, deletedChatMessageIds: undefined },
  ]) assert.throws(() => validateLedger(invalid, backup, now, "historical-offline"));
});

test("failed source connection or backup boundary is never published or marked healthy; optional ledger is not needed for config", async () => temporary(async dir => {
  const archiveDir = path.join(dir, "archives"), bin = path.join(dir, "bin");
  await mkdir(archiveDir, { mode: 0o700 }); await mkdir(bin, { mode: 0o700 });
  const configFile = path.join(dir, "config.json"), keyFile = path.join(dir, "key"), envFile = path.join(dir, "source.env");
  await writePrivate(keyFile, randomBytes(32)); await writePrivate(envFile, `DATABASE_URL=${source}`);
  await writePrivate(configFile, JSON.stringify({ sourceEnvFile: envFile, keyFile, backupDir: archiveDir, postgresBinDir: bin, ledgerFile: path.join(dir, "not-yet-created.json") }));
  const fakeDump = path.join(bin, "pg_dump");
  await writeFile(fakeDump, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "pg_dump (PostgreSQL) 18.7"; exit 0; fi\necho "$PGPASSWORD" >&2\necho incomplete\nexit 1\n', { mode: 0o700 });
  await loadConfig(configFile);
  await assert.rejects(runBackupCli(["backup", "--config", configFile]), error => error instanceof Error && !error.message.includes("synthetic-password"));
  assert.deepEqual(await readdir(archiveDir), ["last-backup.json"]);
  assert.equal(JSON.parse(await readFile(path.join(archiveDir, "last-backup.json"), "utf8")).status, "failed");
  await assert.rejects(runBackupCli(["health", "--config", configFile]));
}));
