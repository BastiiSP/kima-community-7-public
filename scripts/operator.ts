import { createHash } from "node:crypto";
import nextEnv from "@next/env";
import { Pool, type PoolClient } from "pg";
import { operatorDatabaseUrl } from "./operator-config";

const commands = new Set(["status", "members", "member", "block", "unblock", "revoke", "delete", "emergency", "resume"]);
const memberCommands = new Set(["member", "block", "unblock", "revoke", "delete"]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const args = process.argv.slice(2);
const command = args[0];
const target = args[1];
const mutation = !["status", "members", "member"].includes(command);
const memberCommand = memberCommands.has(command);
const expectedConfirmation = memberCommand ? target : command;
const valid = commands.has(command) && (memberCommand ? uuid.test(target ?? "") : true)
  && (mutation ? args.length === (memberCommand ? 4 : 3) && args.at(-2) === "--confirm" && args.at(-1) === expectedConfirmation
    : command === "status" ? args.length === 1 : command === "member" ? args.length === 2 : args.length === 1 || args.length === 2 && uuid.test(target));

async function revokeMember(client: PoolClient, member: { id: string; user_id: string; email: string }) {
  const sessions = await client.query('DELETE FROM session WHERE "userId" = $1', [member.user_id]);
  // Better Auth 1.7.22 email-otp/utils: `${type}-otp-${email}`.
  const identifiers = ["sign-in", "email-verification", "forget-password"].map(type => `${type}-otp-${member.email.toLowerCase()}`);
  const otp = await client.query("DELETE FROM verification WHERE identifier = ANY($1::text[])", [identifiers]);
  const agents = await client.query("UPDATE agent_tokens SET revoked_at = now() WHERE member_id = $1 AND revoked_at IS NULL", [member.id]);
  const invitations = await client.query("UPDATE invitations SET revoked_at = now() WHERE created_by = $1 AND used_at IS NULL AND revoked_at IS NULL", [member.id]);
  return { sessions: sessions.rowCount, otp: otp.rowCount, agents: agents.rowCount, invitations: invitations.rowCount };
}

async function run() {
  if (!valid) throw new Error("usage");
  nextEnv.loadEnvConfig(process.cwd());
  const connectionString = operatorDatabaseUrl();
  const destination = new URL(connectionString);
  const database = { host: destination.hostname, name: destination.pathname.slice(1) };
  const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 8000, statement_timeout: 30000 });
  pool.on("error", () => { console.error("Betreiberverbindung unterbrochen."); process.exitCode = 1; });
  try {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const control = await client.query(`SELECT paused_at AS "pausedAt" FROM community_control WHERE id = 1${mutation ? " FOR UPDATE" : " FOR SHARE"}`);
      if (!control.rowCount) throw new Error("control");
      let result: unknown;
      if (command === "status") {
        const counts = await client.query(`SELECT (SELECT count(*)::integer FROM members) AS members,
          (SELECT count(*)::integer FROM members WHERE blocked_at IS NOT NULL) AS blocked,
          (SELECT count(*)::integer FROM session WHERE "expiresAt" > now()) AS sessions,
          (SELECT count(*)::integer FROM agent_tokens WHERE revoked_at IS NULL AND expires_at > now()) AS agents,
          (SELECT count(*)::integer FROM invitations WHERE revoked_at IS NULL AND used_at IS NULL AND expires_at > now()) AS invitations`);
        result = { ...control.rows[0], ...counts.rows[0] };
      } else if (command === "members") {
        const rows = await client.query(`SELECT m.id, m.first_name AS "firstName", m.last_name AS "lastName", u.email, m.blocked_at AS "blockedAt"
          FROM members m JOIN "user" u ON u.id = m.user_id WHERE ($1::uuid IS NULL OR m.id > $1::uuid) ORDER BY m.id LIMIT 101`, [target ?? null]);
        result = { members: rows.rows.slice(0, 100), nextCursor: rows.rows.length > 100 ? rows.rows[99].id : null };
      } else if (memberCommand) {
        const rows = await client.query(`SELECT m.id, m.user_id, m.first_name AS "firstName", m.last_name AS "lastName", m.blocked_at AS "blockedAt", u.email
          FROM members m JOIN "user" u ON u.id = m.user_id WHERE m.id = $1${mutation ? " FOR UPDATE OF m, u" : ""}`, [target]);
        const member = rows.rows[0];
        if (!member) throw new Error("member");
        if (command === "member") result = member;
        else if (command === "unblock") {
          await client.query("UPDATE members SET blocked_at = NULL WHERE id = $1", [target]);
          result = { memberId: target, blocked: false };
        } else {
          if (command === "block") await client.query("UPDATE members SET blocked_at = COALESCE(blocked_at, now()) WHERE id = $1", [target]);
          const revoked = await revokeMember(client, member);
          result = { memberId: target, revoked };
          if (command === "delete") {
            const chat = await client.query("DELETE FROM chat_messages WHERE author_id = $1", [target]);
            if (chat.rowCount) await client.query("UPDATE chat_control SET deletion_revision = deletion_revision + 1 WHERE id = 1");
            await client.query("DELETE FROM comments WHERE author_id = $1", [target]);
            await client.query("UPDATE posts SET author_id = NULL, body = '', agent_name = NULL, deleted_at = COALESCE(deleted_at, now()), updated_at = now() WHERE author_id = $1", [target]);
            await client.query("DELETE FROM agent_tokens WHERE member_id = $1", [target]);
            // Remove invite linkage and hashes; deletion already invalidated outstanding invitations.
            await client.query("DELETE FROM invitations WHERE created_by = $1 OR used_by = $1", [target]);
            const rateKeys = [`feed:${target}`, `chat:read:${target}`, `content:${target}`, `content:daily:${target}`, `agent:publish:${target}`, `invite:${target}`, `agent:create:${target}`, `join:${member.user_id}`,
              `auth:/email-otp/send-verification-otp:${member.email.toLowerCase()}`, `auth:/sign-in/email-otp:${member.email.toLowerCase()}`];
            await client.query("DELETE FROM app_rate_limits WHERE key = ANY($1::text[])", [rateKeys.map(key => createHash("sha256").update(key).digest("hex"))]);
            await client.query("DELETE FROM members WHERE id = $1", [target]);
            await client.query('DELETE FROM "user" WHERE id = $1', [member.user_id]);
          }
        }
      } else if (command === "emergency") {
        await client.query("UPDATE community_control SET paused_at = COALESCE(paused_at, now()) WHERE id = 1");
        const sessions = await client.query("DELETE FROM session");
        const otp = await client.query("DELETE FROM verification");
        const agents = await client.query("UPDATE agent_tokens SET revoked_at = now() WHERE revoked_at IS NULL");
        const invitations = await client.query("UPDATE invitations SET revoked_at = now() WHERE used_at IS NULL AND revoked_at IS NULL");
        result = { paused: true, revoked: { sessions: sessions.rowCount, otp: otp.rowCount, agents: agents.rowCount, invitations: invitations.rowCount } };
      } else {
        await client.query("UPDATE community_control SET paused_at = NULL WHERE id = 1");
        result = { paused: false };
      }
      await client.query("COMMIT");
      console.log(JSON.stringify({ command, database, result }));
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  } finally { await pool.end(); }
}

try { await run(); }
catch (error) {
  const kind = error instanceof Error ? error.message : "";
  console.error(kind === "usage"
    ? "Nutzung: npm run ops -- status | members [nach-UUID] | member UUID | block/unblock/revoke/delete UUID --confirm UUID | emergency/resume --confirm emergency/resume"
    : kind === "member" ? "Mitglied nicht gefunden. Zielkennung mit members/member prüfen."
    : "Betreiberaktion fehlgeschlagen; nicht als abgeschlossen behandeln. Zielumgebung, sichere Verbindung, Migrationen und Datenbankrechte prüfen.");
  process.exitCode = 1;
}
