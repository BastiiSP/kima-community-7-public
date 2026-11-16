import { createHash, randomBytes, randomUUID } from "node:crypto";
import nextEnv from "@next/env";
import { Pool } from "pg";
import { operatorDatabaseUrl } from "./operator-config";

nextEnv.loadEnvConfig(process.cwd());
if (!process.argv.includes("--bootstrap")) throw new Error("Für die erste Einladung ausdrücklich --bootstrap angeben.");
if (!process.env.DATABASE_URL || !process.env.BETTER_AUTH_URL) throw new Error("DATABASE_URL und BETTER_AUTH_URL fehlen.");
const origin = new URL(process.env.BETTER_AUTH_URL).origin;
const pool = new Pool({ connectionString: operatorDatabaseUrl(), max: 1 });
const client = await pool.connect();
try {
  await client.query("BEGIN");
  const control = await client.query("SELECT paused_at FROM community_control WHERE id = 1 FOR UPDATE");
  if (!control.rowCount || control.rows[0].paused_at) throw new Error("paused");
  // Blocks concurrent bootstrap calls and joins while checking the empty community.
  await client.query("LOCK TABLE members, invitations IN EXCLUSIVE MODE");
  const members = await client.query("SELECT id FROM members LIMIT 1");
  const pending = await client.query("SELECT id FROM invitations WHERE used_at IS NULL AND revoked_at IS NULL AND expires_at > now() LIMIT 1");
  if (members.rowCount || pending.rowCount) throw new Error("Es existiert bereits eine Mitgliedschaft oder gültige Einladung. Nutze Einladungen in der Community.");
  const token = randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update(token).digest("hex");
  await client.query("INSERT INTO invitations (id, token_hash, expires_at) VALUES ($1, $2, now() + interval '7 days')", [randomUUID(), hash]);
  await client.query("COMMIT");
  console.log("Einmaliger privater Einladungslink (7 Tage gültig; nicht in Projektdateien speichern):");
  console.log(`${origin}/#invite=${token}`);
} catch (error) {
  await client.query("ROLLBACK");
  console.error(error instanceof Error && error.message.startsWith("Es existiert") ? error.message : "Einladung konnte nicht erstellt werden. Datenbankkonfiguration und Migration prüfen.");
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
