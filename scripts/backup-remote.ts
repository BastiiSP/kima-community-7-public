import { chmod, cp, lstat, mkdir, mkdtemp, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { Client } from "pg";
import { connectionFromFile, databaseUrl, fail, loadConfig, type BackupConfig, readPrivate } from "./backup-config";
import { runBackupCli } from "./backup";
import { bundleIds, decryptBundle, encryptStream, lockDirectory, newHeader, publishBundle, readManifest, writePrivate } from "./backup-storage";
import { exportBackupLedger } from "./backup-ledger";
import { restoreBackup } from "./backup-restore";

const limit = 40 * 1024 * 1024;
const prefix = "kima-backup-run-";

export function decodeKey(value: string) {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) throw fail();
  const key = Buffer.from(value, "base64");
  if (key.length !== 32 || key.toString("base64") !== value) throw fail();
  return key;
}

async function output(name: string, value: string) {
  if (!process.env.GITHUB_OUTPUT || /[\r\n]/.test(value)) throw fail();
  await writeFile(process.env.GITHUB_OUTPUT, `${name}=${value}\n`, { flag: "a" });
}

async function runRoot(value: string) {
  const temp = await realpath(process.env.RUNNER_TEMP ?? "/nonexistent");
  const root = await realpath(value);
  if (path.dirname(root) !== temp || !path.basename(root).startsWith(prefix) || root === temp) throw fail();
  return root;
}

async function config(root: string): Promise<BackupConfig> {
  return JSON.parse((await readPrivate(path.join(root, "config.json"))).toString("utf8"));
}

async function prepare() {
  const db = process.env.KIMA_BACKUP_DATABASE_URL;
  const keyBase64 = process.env.KIMA_BACKUP_KEY_BASE64;
  if (!db || !keyBase64 || !process.env.RUNNER_TEMP) throw fail();
  databaseUrl(db, "source");
  const key = decodeKey(keyBase64);
  const temp = await realpath(process.env.RUNNER_TEMP);
  const root = await mkdtemp(path.join(temp, prefix));
  try {
    await mkdir(path.join(root, "archives"), { mode: 0o700 });
    await writePrivate(path.join(root, "source.env"), `DATABASE_URL=${db}\n`);
    await writePrivate(path.join(root, "key"), key);
    const backup: BackupConfig = { sourceEnvFile: path.join(root, "source.env"), keyFile: path.join(root, "key"), backupDir: path.join(root, "archives"), postgresBinDir: "/usr/lib/postgresql/18/bin", retentionDays: 7 };
    await writePrivate(path.join(root, "config.json"), JSON.stringify(backup));
    await output("root", root);
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
  finally { key.fill(0); }
}

async function backup(root: string) {
  const cfg = await config(root);
  const key = await readPrivate(cfg.keyFile, true, 32);
  try {
    const result = await runBackupCli(["backup", "--config", path.join(root, "config.json")]);
    const databaseId = result.id as string;
    await readManifest(cfg.backupDir, databaseId);
    const ledger = await exportBackupLedger(cfg, key, databaseId);
    const header = newHeader("ledger");
    await publishBundle(cfg.backupDir, header, file => encryptStream(Readable.from([JSON.stringify(ledger)]), file, key, header));
    await decryptBundle(cfg.backupDir, header.id, key);
    await runBackupCli(["source", "--config", path.join(root, "config.json")]);
    await runBackupCli(["verify", "--config", path.join(root, "config.json")]);
    await runBackupCli(["health", "--config", path.join(root, "config.json")]);
    const upload = path.join(root, "upload");
    await mkdir(upload, { mode: 0o700 });
    const ids = await bundleIds(cfg.backupDir);
    if (ids.length !== 3 || !ids.includes(databaseId) || !ids.includes(header.id)) throw fail();
    let bytes = 0;
    for (const id of ids) {
      const { dir, manifest: item } = await readManifest(cfg.backupDir, id);
      bytes += item.bytes + (await stat(path.join(dir, "manifest.json"))).size;
      if (bytes > limit) throw fail();
      await cp(dir, path.join(upload, id), { recursive: true });
    }
    await output("upload", upload);
    await output("database_id", databaseId);
    await output("bundle_bytes", String(bytes));
    return { databaseId, bundleBytes: bytes };
  } finally { key.fill(0); }
}

async function command(binary: string, args: string[], env: Record<string, string> = {}) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(binary, args, { env: { NODE_ENV: "production", PATH: "/usr/lib/postgresql/18/bin:/usr/bin:/bin", LANG: "C", LC_ALL: "C", ...env }, stdio: "ignore" });
    child.once("error", reject);
    child.once("close", code => code === 0 ? resolve() : reject(fail()));
  });
}

export async function normalizedDownload(root: string) {
  const download = path.join(root, "download");
  if ((await lstat(download)).isSymbolicLink()) throw fail();
  await chmod(download, 0o700);
  const ids = (await readdir(download)).sort();
  if (ids.length !== 3 || ids.some(id => !/^(database|source|ledger)-\d{8}T\d{6}Z-[0-9a-f-]{36}$/.test(id))) throw fail();
  const kinds = ids.map(id => id.split("-")[0]).sort();
  if (kinds.join(",") !== "database,ledger,source") throw fail();
  let bytes = 0;
  for (const id of ids) {
    const dir = path.join(download, id);
    if (!(await lstat(dir)).isDirectory()) throw fail();
    await chmod(dir, 0o700);
    const entries = (await readdir(dir)).sort();
    if (entries.join(",") !== "manifest.json,payload.enc") throw fail();
    for (const entry of entries) {
      const file = path.join(dir, entry), info = await lstat(file);
      if (!info.isFile() || info.nlink !== 1) throw fail();
      bytes += info.size;
      if (bytes > limit) throw fail();
      await chmod(file, 0o600);
    }
  }
  return { download, ids };
}

async function restoreCheck(root: string, databaseId: string, mode: "current" | "historical-offline" = "current") {
  // A historical rehearsal must invalidate any earlier success gate, including on failure.
  if (mode === "historical-offline") await rm(path.join(root, "restore-ok.json"), { force: true });
  const cfg = await config(root);
  const key = await readPrivate(cfg.keyFile, true, 32);
  const { download, ids } = await normalizedDownload(root);
  if (!ids.includes(databaseId)) throw fail();
  const ledgerId = ids.find(id => id.startsWith("ledger-"))!;
  const ledgerFile = path.join(root, "ledger.json");
  const data = path.join(root, "pgdata"), passwordFile = path.join(root, "pgpass"), pglog = path.join(root, "postgres.log");
  const password = randomBytes(32).toString("base64url");
  let started = false;
  try {
    for (const id of ids) await decryptBundle(download, id, key);
    const manifest = (await readManifest(download, databaseId)).manifest;
    const ledgerManifest = await decryptBundle(download, ledgerId, key, ledgerFile);
    if (ledgerManifest.header.kind !== "ledger") throw fail();
    const ledger = JSON.parse((await readPrivate(ledgerFile, true, 32 * 1024 * 1024)).toString("utf8"));
    if (ledger.backupId !== databaseId || ledger.backupStartedAt !== manifest.header.startedAt) throw fail();
    await writePrivate(passwordFile, `${password}\n`);
    const bin = cfg.postgresBinDir;
    await command(path.join(bin, "initdb"), ["-D", data, "--username=restore_operator", "--auth-host=scram-sha-256", "--auth-local=scram-sha-256", `--pwfile=${passwordFile}`]);
    await command(path.join(bin, "pg_ctl"), ["-D", data, "-l", pglog, "-o", `-c listen_addresses=127.0.0.1 -p 55432 -c unix_socket_directories=${root}`, "-w", "start"]);
    started = true;
    await command(path.join(bin, "createdb"), ["-h", "127.0.0.1", "-p", "55432", "-U", "restore_operator", "kima_restore_daily"], { PGPASSWORD: password });
    const restoreEnv = path.join(root, "restore.env");
    await writePrivate(restoreEnv, `DATABASE_URL=postgres://restore_operator:${encodeURIComponent(password)}@127.0.0.1:55432/kima_restore_daily?sslmode=disable\n`);
    await writePrivate(path.join(root, "restore-config.json"), JSON.stringify({ ...cfg, backupDir: download, restoreEnvFile: restoreEnv, ledgerFile }));
    const restored = mode === "historical-offline"
      ? await lockDirectory(download, async () => restoreBackup(await loadConfig(path.join(root, "restore-config.json")), key, databaseId, mode))
      : await runBackupCli(["restore", "--config", path.join(root, "restore-config.json"), "--id", databaseId, "--confirm", databaseId]);
    if (!("paused" in restored) || !restored.paused || !("ledgerApplied" in restored) || !restored.ledgerApplied || !("productionReady" in restored) || restored.productionReady !== false
      || (mode === "historical-offline" && (!("ledgerTailUnknown" in restored) || restored.ledgerTailUnknown !== true))) throw fail();
    const target = new Client({ connectionString: (await connectionFromFile(restoreEnv, "restore")).toString() });
    try {
      await target.connect();
      const status = await target.query(`SELECT (SELECT paused_at IS NOT NULL FROM public.community_control WHERE id=1) AS paused,
        (SELECT count(*)::integer FROM public.session) AS sessions,
        (SELECT count(*)::integer FROM public.verification) AS otps,
        (SELECT count(*)::integer FROM public.invitations WHERE revoked_at IS NULL) AS invitations,
        (SELECT count(*)::integer FROM public.agent_tokens WHERE revoked_at IS NULL) AS agent_tokens`);
      const row = status.rows[0];
      if (!row?.paused || [row.sessions, row.otps, row.invitations, row.agent_tokens].some(value => value !== 0)) throw fail();
    } finally { await target.end(); }
    if (mode === "current") await writePrivate(path.join(root, "restore-ok.json"), JSON.stringify({ id: databaseId, verifiedAt: new Date().toISOString() }));
    return { id: databaseId, paused: true, productionReady: false,
      ...(mode === "historical-offline" ? { ledgerTailUnknown: true } : {}) };
  } finally {
    key.fill(0);
    if (started) await command(path.join(cfg.postgresBinDir, "pg_ctl"), ["-D", data, "-m", "immediate", "-w", "stop"]).catch(() => { throw fail(); });
    await rm(data, { recursive: true, force: true });
    await rm(passwordFile, { force: true });
    await rm(ledgerFile, { force: true });
    await rm(path.join(root, "restore.env"), { force: true });
    await rm(path.join(root, "restore-config.json"), { force: true });
  }
}

export function validHealthMarker(value: unknown, id: string, now = Date.now()) {
  if (!value || typeof value !== "object" || !("id" in value) || !("verifiedAt" in value)) return false;
  const gate = value as { id: unknown; verifiedAt: unknown };
  const verifiedAt = typeof gate.verifiedAt === "string" ? Date.parse(gate.verifiedAt) : NaN;
  return gate.id === id && Number.isFinite(verifiedAt) && verifiedAt <= now && now - verifiedAt <= 15 * 60_000;
}

async function markSuccess(root: string, id: string) {
  const gate = JSON.parse((await readPrivate(path.join(root, "restore-ok.json"))).toString("utf8"));
  if (!validHealthMarker(gate, id)) throw fail();
  const cfg = await config(root);
  const source = await connectionFromFile(cfg.sourceEnvFile, "source");
  const client = new Client({ connectionString: source.toString(), connectionTimeoutMillis: 15_000, application_name: "kima-backup-health" });
  try {
    await client.connect();
    const result = await client.query("UPDATE public.backup_health SET last_verified_at=now(), backup_id=$1 WHERE id=1 RETURNING id", [id]);
    if (result.rowCount !== 1) throw fail();
  } finally { await client.end(); }
  return { id, healthMarked: true };
}

export async function runRemoteCli(args: string[]) {
  const [name, rootValue, id] = args;
  if (name === "prepare" && args.length === 1) return prepare();
  if (!rootValue || !["backup", "restore-check", "restore-offline-check", "mark-success", "cleanup"].includes(name)) throw fail();
  const root = await runRoot(rootValue);
  if (name === "backup" && args.length === 2) return backup(root);
  if (name === "restore-check" && args.length === 3 && id) return restoreCheck(root, id);
  if (name === "restore-offline-check" && args.length === 3 && id) return restoreCheck(root, id, "historical-offline");
  if (name === "mark-success" && args.length === 3 && id) return markSuccess(root, id);
  if (name === "cleanup" && args.length === 2) { await rm(root, { recursive: true, force: true }); return { cleaned: true }; }
  throw fail();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.umask(0o077);
  try { const result = await runRemoteCli(process.argv.slice(2)); if (result) console.log(JSON.stringify(result)); }
  catch { console.error("Remote-Sicherung oder Wiederherstellungsprüfung fehlgeschlagen."); process.exitCode = 1; }
}
