import { Readable } from "node:stream";
import { Client } from "pg";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { readdir } from "node:fs/promises";
import { connectionFromFile, encryptionKey, fail, loadConfig, readPrivate, type BackupConfig } from "./backup-config";
import { atomicJson, bundleIds, decryptBundle, encryptStream, lockDirectory, newHeader, publishBundle, retainBundles, stale } from "./backup-storage";
import { postgresBinary, postgresProcess } from "./backup-process";
import { sourceSnapshot } from "./backup-source";
import { restoreBackup } from "./backup-restore";

export function parseArguments(args: string[]) {
  const [command, ...rest] = args;
  if (!["backup", "source", "verify", "health", "restore"].includes(command) || rest.length % 2) throw fail();
  const values = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 2) {
    const name = rest[index], value = rest[index + 1];
    if (!["--config", "--id", "--confirm"].includes(name) || values.has(name) || !value) throw fail();
    values.set(name, value);
  }
  if (!values.get("--config") || (command !== "restore" && values.size !== 1)
    || (command === "restore" && (values.size !== 3 || values.get("--id") !== values.get("--confirm")))) throw fail();
  return { command, configFile: values.get("--config")!, id: values.get("--id") };
}

async function databaseBackup(config: BackupConfig, key: Buffer) {
  const header = newHeader("database");
  await atomicJson(config.backupDir, "last-backup.json", { status: "running", attemptedAt: header.startedAt });
  try {
    const source = await connectionFromFile(config.sourceEnvFile, "source");
    const executable = await postgresBinary(config.postgresBinDir, "pg_dump");
    const boundary = new Client({ connectionString: source.toString(), connectionTimeoutMillis: 15_000,
      statement_timeout: 30_000, application_name: "kima-backup-boundary" });
    boundary.on("error", () => {});
    try {
      await boundary.connect();
      await boundary.query("BEGIN");
      await boundary.query("SET LOCAL lock_timeout = '30s'");
      const stamp = await boundary.query("SELECT public.record_recovery_boundary($1) AS started_at", [header.id]);
      header.startedAt = new Date(stamp.rows[0].started_at).toISOString();
      await boundary.query("COMMIT");
    } catch {
      await boundary.query("ROLLBACK").catch(() => {});
      throw fail();
    } finally { await boundary.end(); }
    await publishBundle(config.backupDir, header, async file => {
      const process = postgresProcess(executable, ["--format=custom", "--schema=public", "--no-owner", "--no-privileges", "--no-password", "--lock-wait-timeout=30000"], source, config.postgresBinDir);
      try {
        const [manifest] = await Promise.all([encryptStream(process.child.stdout, file, key, header), process.done]);
        return manifest;
      } finally { if (process.child.exitCode === null) process.child.kill("SIGKILL"); }
    });
    // A successful write alone is insufficient: authenticate and verify stored bytes.
    await decryptBundle(config.backupDir, header.id, key);
    await retainBundles(config.backupDir, key, config.retentionDays);
    await atomicJson(config.backupDir, "last-backup.json", { status: "success", attemptedAt: header.startedAt, id: header.id });
    return { id: header.id, verified: true, scope: "public", retentionDays: 7 };
  } catch {
    await atomicJson(config.backupDir, "last-backup.json", { status: "failed", attemptedAt: header.startedAt });
    throw fail();
  }
}

export async function runBackupCli(args: string[]) {
  const options = parseArguments(args);
  const config = await loadConfig(options.configFile);
  const key = await encryptionKey(config);
  try {
    return await lockDirectory(config.backupDir, async () => {
      if (options.command === "backup") return databaseBackup(config, key);
      if (options.command === "source") {
        const header = newHeader("source");
        const snapshot = await sourceSnapshot();
        await publishBundle(config.backupDir, header, file => encryptStream(Readable.from([snapshot]), file, key, header));
        await decryptBundle(config.backupDir, header.id, key);
        await retainBundles(config.backupDir, key, config.retentionDays);
        return { id: header.id, verified: true, scope: "source-allowlist", atomicSourceSnapshot: false };
      }
      if (options.command === "restore") return restoreBackup(config, key, options.id!);
      if ((await readdir(config.backupDir)).some(name => name.startsWith(".pending-") || name.startsWith(".restore-") || name.startsWith(".state-"))) throw fail();
      const ids = await bundleIds(config.backupDir);
      if (!ids.some(id => id.startsWith("database-"))) throw fail();
      if (options.command === "verify") {
        for (const id of ids) await decryptBundle(config.backupDir, id, key);
        return { verified: ids.length, restoreTested: false };
      }
      const status = JSON.parse((await readPrivate(path.join(config.backupDir, "last-backup.json"))).toString("utf8"));
      const latest = ids.filter(id => id.startsWith("database-")).at(-1)!;
      if (status.status !== "success" || status.id !== latest) throw fail();
      const manifest = await decryptBundle(config.backupDir, latest, key);
      if (stale(manifest)) throw fail();
      return { healthy: true, id: latest, startedAt: manifest.header.startedAt, maxAgeHours: 26, restoreTested: false };
    });
  } finally { key.fill(0); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.umask(0o077);
  try { console.log(JSON.stringify(await runBackupCli(process.argv.slice(2)))); }
  catch {
    console.error("Sicherung/Wiederherstellung fehlgeschlagen. Kein Erfolg bestätigt; Konfiguration, Rechte, freien Speicher, Sperrverzeichnis und Zielisolation prüfen. Bei Restorefehler bleibt das lokale Ziel unfreigegeben; keine App verbinden. Nutzung: backup|source|verify|health --config DATEI; restore --config DATEI --id KENNUNG --confirm KENNUNG.");
    process.exitCode = 1;
  }
}
