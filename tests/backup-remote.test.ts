import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { decodeKey, normalizedDownload, runRemoteCli, validHealthMarker } from "../scripts/backup-remote";

const fakeId = (kind: string) => `${kind}-20261116T172300Z-11111111-1111-4111-8111-111111111111`;

test("base64 key is exactly 32 canonical bytes", () => {
  const encoded = randomBytes(32).toString("base64");
  assert.deepEqual(decodeKey(encoded).toString("base64"), encoded);
  for (const value of ["", "a".repeat(44), encoded.slice(0, -1) + "A", Buffer.from("short").toString("base64")]) assert.throws(() => decodeKey(value));
});

test("prepare places all secrets in private runner files and guarded cleanup removes them", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "remote-fixture-"));
  const previous = { ...process.env };
  try {
    process.env.RUNNER_TEMP = temp;
    process.env.GITHUB_OUTPUT = path.join(temp, "output");
    process.env.KIMA_BACKUP_DATABASE_URL = "postgres://backup:fixture@db.example.test/kima?sslmode=verify-full";
    process.env.KIMA_BACKUP_KEY_BASE64 = randomBytes(32).toString("base64");
    await runRemoteCli(["prepare"]);
    const outputs = await readFile(process.env.GITHUB_OUTPUT, "utf8");
    const root = outputs.match(/^root=(.+)$/m)?.[1];
    assert.ok(root);
    for (const file of ["config.json", "source.env", "key"]) assert.equal((await lstat(path.join(root, file))).mode & 0o777, 0o600);
    assert.equal((await lstat(root)).mode & 0o777, 0o700);
    assert.equal((await lstat(path.join(root, "archives"))).mode & 0o777, 0o700);
    assert.equal(outputs.includes("db.example.test"), false);
    await assert.rejects(runRemoteCli(["cleanup", temp]));
    await runRemoteCli(["cleanup", root]);
    await assert.rejects(lstat(root));
  } finally { process.env = previous; await rm(temp, { recursive: true, force: true }); }
});

test("download gate accepts only three regular encrypted bundle directories", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remote-download-"));
  try {
    const download = path.join(root, "download");
    await mkdir(download);
    for (const kind of ["database", "source", "ledger"]) {
      const dir = path.join(download, fakeId(kind));
      await mkdir(dir);
      await writeFile(path.join(dir, "manifest.json"), "{}");
      await writeFile(path.join(dir, "payload.enc"), "encrypted");
    }
    assert.equal((await normalizedDownload(root)).ids.length, 3);
    assert.equal((await lstat(path.join(download, fakeId("database"), "payload.enc"))).mode & 0o777, 0o600);
    await writeFile(path.join(download, "plaintext.txt"), "unsafe");
    await assert.rejects(normalizedDownload(root));
    await rm(path.join(download, "plaintext.txt"));
    await rm(path.join(download, fakeId("ledger"), "payload.enc"));
    await symlink(path.join(download, fakeId("source"), "payload.enc"), path.join(download, fakeId("ledger"), "payload.enc"));
    await assert.rejects(normalizedDownload(root));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("offline check removes a prior health gate before an unsuccessful rehearsal", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "remote-offline-fixture-"));
  const root = await mkdtemp(path.join(temp, "kima-backup-run-"));
  const previous = process.env.RUNNER_TEMP;
  try {
    process.env.RUNNER_TEMP = temp;
    await writeFile(path.join(root, "restore-ok.json"), JSON.stringify({ id: fakeId("database"), verifiedAt: new Date().toISOString() }), { mode: 0o600 });
    await assert.rejects(runRemoteCli(["restore-offline-check", root, fakeId("database")]));
    await assert.rejects(lstat(path.join(root, "restore-ok.json")));
    await assert.rejects(runRemoteCli(["mark-success", root, fakeId("database")]));
  } finally {
    if (previous === undefined) delete process.env.RUNNER_TEMP;
    else process.env.RUNNER_TEMP = previous;
    await rm(temp, { recursive: true, force: true });
  }
});

test("health marker requires a finite recent timestamp and matching id", () => {
  const now = Date.parse("2026-11-18T12:00:00.000Z");
  const id = fakeId("database");
  assert.equal(validHealthMarker({ id, verifiedAt: new Date(now).toISOString() }, id, now), true);
  for (const gate of [
    { id, verifiedAt: "invalid" }, { id, verifiedAt: null },
    { id, verifiedAt: new Date(now + 1000).toISOString() },
    { id, verifiedAt: new Date(now - 16 * 60_000).toISOString() },
    { id: fakeId("source"), verifiedAt: new Date(now).toISOString() },
  ]) assert.equal(validHealthMarker(gate, id, now), false);
});
