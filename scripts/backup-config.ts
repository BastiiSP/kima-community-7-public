import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { z } from "zod";

export const projectRoot = fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/, "");
export const configSchema = z.object({
  sourceEnvFile: z.string(), keyFile: z.string(), backupDir: z.string(), postgresBinDir: z.string(),
  restoreEnvFile: z.string().optional(), ledgerFile: z.string().optional(),
  retentionDays: z.literal(7).default(7),
}).strict();
export type BackupConfig = z.infer<typeof configSchema>;
export const fail = () => new Error("Sicherungsprüfung fehlgeschlagen.");

export function within(child: string, parent: string) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

/** Reject symlinks in every path component, not only the final file. */
export async function checkedPath(value: string, external = false) {
  if (!path.isAbsolute(value) || value !== path.resolve(value)) throw fail();
  let cursor = path.parse(value).root;
  for (const part of value.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    if ((await lstat(cursor)).isSymbolicLink()) throw fail();
  }
  if (external && within(value, await realpath(projectRoot))) throw fail();
  return value;
}

export async function privateDirectory(value: string, external = true) {
  await checkedPath(value, external);
  const stat = await lstat(value);
  if (!stat.isDirectory() || (stat.mode & 0o777) !== 0o700 || stat.uid !== process.getuid?.()) throw fail();
  return value;
}

export async function readPrivate(value: string, external = true, maxBytes = 1024 * 1024) {
  await checkedPath(value, external);
  const handle = await open(value, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid?.() || stat.size > maxBytes) throw fail();
    return await handle.readFile();
  } finally { await handle.close(); }
}

export async function loadConfig(filename: string): Promise<BackupConfig> {
  const config = configSchema.parse(JSON.parse((await readPrivate(filename)).toString("utf8")));
  await privateDirectory(config.backupDir);
  for (const file of [filename, config.keyFile, config.sourceEnvFile, config.restoreEnvFile, config.ledgerFile].filter((v): v is string => !!v)) {
    await checkedPath(path.dirname(file), true);
    if (!path.isAbsolute(file) || file !== path.resolve(file) || within(file, config.backupDir)) throw fail();
  }
  await checkedPath(config.postgresBinDir);
  return config;
}

export async function encryptionKey(config: BackupConfig) {
  const key = await readPrivate(config.keyFile, true, 32);
  if (key.length !== 32) throw fail();
  return key;
}

export function databaseUrl(value: string, purpose: "source" | "restore") {
  const url = new URL(value);
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || !url.username || !url.pathname || url.hash) throw fail();
  const allowed = new Set(["sslmode", "sslrootcert", "channel_binding"]);
  if ([...url.searchParams.keys()].some(key => !allowed.has(key) || url.searchParams.getAll(key).length !== 1)) throw fail();
  const database = decodeURIComponent(url.pathname.slice(1));
  if (!database || database.includes("/") || url.hostname.includes("-pooler")) throw fail();
  if (purpose === "source") {
    if (url.searchParams.get("sslmode") !== "verify-full") throw fail();
  } else {
    if (!["127.0.0.1", "[::1]"].includes(url.hostname) || !/^kima_restore_[a-z0-9_]{1,40}$/.test(database)
      || !["disable", "verify-full"].includes(url.searchParams.get("sslmode") ?? "")) throw fail();
  }
  if (url.searchParams.has("channel_binding") && url.searchParams.get("channel_binding") !== "require") throw fail();
  return url;
}

export async function connectionFromFile(file: string, purpose: "source" | "restore") {
  const parsed = parseEnv((await readPrivate(file)).toString("utf8"));
  if (!parsed.DATABASE_URL) throw fail();
  const url = databaseUrl(parsed.DATABASE_URL, purpose);
  const rootcert = url.searchParams.get("sslrootcert");
  if (rootcert && rootcert !== "system") await checkedPath(rootcert, true);
  return url;
}

/** No inherited PG*, NODE_OPTIONS, PGPASSFILE, service file or shell environment. */
export function postgresEnvironment(url: URL, bin: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: "production", PATH: `${bin}:/usr/bin:/bin`, LANG: "C", LC_ALL: "C", PGCONNECT_TIMEOUT: "15",
    PGHOST: url.hostname.replace(/^\[|\]$/g, ""), PGPORT: url.port || "5432",
    PGDATABASE: decodeURIComponent(url.pathname.slice(1)), PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password), PGSSLMODE: url.searchParams.get("sslmode")!,
    PGPASSFILE: "/dev/null", PGSERVICEFILE: "/dev/null", PGSYSCONFDIR: "/dev/null",
    PGOPTIONS: "-c statement_timeout=900000 -c lock_timeout=30000", PGAPPNAME: "kima-backup",
  };
  const rootcert = url.searchParams.get("sslrootcert");
  if (url.searchParams.get("sslmode") === "verify-full") env.PGSSLROOTCERT = rootcert || "system";
  const binding = url.searchParams.get("channel_binding");
  if (binding) env.PGCHANNELBINDING = binding;
  return env;
}
