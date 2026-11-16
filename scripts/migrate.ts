import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import nextEnv from "@next/env";
import { operatorDatabaseUrl } from "./operator-config";

async function migrate() {
  nextEnv.loadEnvConfig(process.cwd());
  const pool = new Pool({ connectionString: operatorDatabaseUrl(), max: 1, connectionTimeoutMillis: 8000, statement_timeout: 30000 });
  pool.on("error", () => { console.error("Migrationsverbindung unterbrochen."); process.exitCode = 1; });
  try {
    const client = await pool.connect();
    try {
      // A transaction-scoped lock also works with Neon/PgBouncer transaction
      // pooling. The complete migration batch and checksums commit together.
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(717007)");
      await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())");
      const directory = fileURLToPath(new URL("../migrations/", import.meta.url));
      const files = (await readdir(directory)).filter(name => /^\d+.*\.sql$/.test(name)).sort();
      const applied: string[] = [];
      for (const name of files) {
        const sql = await readFile(join(directory, name), "utf8");
        const checksum = createHash("sha256").update(sql).digest("hex");
        const existing = await client.query("SELECT checksum FROM schema_migrations WHERE name = $1", [name]);
        if (existing.rowCount) {
          if (existing.rows[0].checksum !== checksum) throw new Error("Applied migration checksum differs.");
          continue;
        }
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)", [name, checksum]);
        applied.push(name);
      }
      await client.query("COMMIT");
      for (const name of applied) console.log(`Migration angewandt: ${name}`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  } finally { await pool.end(); }
}

try { await migrate(); }
catch {
  console.error("Migration fehlgeschlagen. Datenbankzugang und Schema prüfen; bestehende Migrationen nicht verändern.");
  process.exitCode = 1;
}
