import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { Client } from "pg";
import { z } from "zod";
import { type BackupConfig, connectionFromFile, fail, readPrivate } from "./backup-config";
import { decryptBundle } from "./backup-storage";
import { postgresBinary, postgresProcess } from "./backup-process";

const ids = z.array(z.uuid()).max(100_000);
export const ledgerSchema = z.object({
  format: z.literal(1), backupId: z.string(), backupStartedAt: z.iso.datetime(), reviewedThrough: z.iso.datetime(), complete: z.literal(true),
  blockedMemberIds: ids, deletedMemberIds: ids, deletedPostIds: ids, deletedCommentIds: ids, deletedChatMessageIds: ids,
}).strict();
export type RecoveryLedger = z.infer<typeof ledgerSchema>;

export function validateLedger(value: unknown, backup: { id: string; startedAt: string }, now = Date.now(), mode: "current" | "historical-offline" = "current") {
  const ledger = ledgerSchema.parse(value);
  const reviewed = Date.parse(ledger.reviewedThrough);
  if (ledger.backupId !== backup.id || ledger.backupStartedAt !== backup.startedAt || reviewed < Date.parse(backup.startedAt)
    || reviewed > now + 60_000 || (mode === "current" && reviewed < now - 60 * 60_000)) throw fail();
  return ledger;
}

/** Mirrors operator deletion semantics; the entire restored community remains paused. */
export async function hardenRestore(client: Pick<Client, "query">, ledger: RecoveryLedger) {
  await client.query("BEGIN");
  try {
    const control = await client.query("UPDATE public.community_control SET paused_at = COALESCE(paused_at, now()) WHERE id = 1 RETURNING id");
    if (control.rowCount !== 1) throw fail();
    // Pre-journal backups have no monitor table. A restored verification stamp
    // never certifies the restored system or permits an automatic resume.
    await client.query(`DO $$ BEGIN
      IF to_regclass('public.backup_health') IS NOT NULL THEN
        UPDATE public.backup_health SET last_verified_at = NULL, backup_id = NULL WHERE id = 1;
      END IF;
    END $$`);
    // --no-privileges restores PostgreSQL's default PUBLIC EXECUTE on functions.
    // Remove it before any runtime role can be provisioned on this isolated DB.
    await client.query(`DO $$ DECLARE signature text; BEGIN
      FOREACH signature IN ARRAY ARRAY['public.record_recovery_intent()', 'public.reject_recovery_gap()',
        'public.record_recovery_boundary(text)', 'public.export_recovery_journal(text,timestamptz)'] LOOP
        IF to_regprocedure(signature) IS NOT NULL THEN
          EXECUTE 'REVOKE ALL ON FUNCTION ' || signature || ' FROM PUBLIC';
        END IF;
      END LOOP;
    END $$`);
    await client.query("DELETE FROM public.session");
    await client.query("DELETE FROM public.verification");
    await client.query("UPDATE public.agent_tokens SET revoked_at = COALESCE(revoked_at, now())");
    await client.query("UPDATE public.invitations SET revoked_at = COALESCE(revoked_at, now())");
    await client.query("DELETE FROM public.app_rate_limits");
    await client.query('DELETE FROM public."rateLimit"');
    await client.query("UPDATE public.members SET blocked_at = COALESCE(blocked_at, now()) WHERE id = ANY($1::uuid[])", [ledger.blockedMemberIds]);
    await client.query("DELETE FROM public.chat_messages WHERE id = ANY($1::uuid[]) OR author_id = ANY($2::uuid[])", [ledger.deletedChatMessageIds, ledger.deletedMemberIds]);
    await client.query("UPDATE public.chat_control SET deletion_revision = deletion_revision + 1 WHERE id = 1");
    await client.query("DELETE FROM public.comments WHERE id = ANY($1::uuid[]) OR author_id = ANY($2::uuid[])", [ledger.deletedCommentIds, ledger.deletedMemberIds]);
    await client.query("UPDATE public.posts SET body = '', agent_name = NULL, deleted_at = COALESCE(deleted_at, now()), updated_at = now() WHERE id = ANY($1::uuid[])", [ledger.deletedPostIds]);
    await client.query("UPDATE public.posts SET author_id = NULL, body = '', agent_name = NULL, deleted_at = COALESCE(deleted_at, now()), updated_at = now() WHERE author_id = ANY($1::uuid[])", [ledger.deletedMemberIds]);
    await client.query("DELETE FROM public.agent_tokens WHERE member_id = ANY($1::uuid[])", [ledger.deletedMemberIds]);
    await client.query("DELETE FROM public.invitations WHERE created_by = ANY($1::uuid[]) OR used_by = ANY($1::uuid[])", [ledger.deletedMemberIds]);
    const deleted = await client.query("DELETE FROM public.members WHERE id = ANY($1::uuid[]) RETURNING user_id", [ledger.deletedMemberIds]);
    await client.query('DELETE FROM public."user" WHERE id = ANY($1::text[])', [deleted.rows.map((row: { user_id: string }) => row.user_id)]);
    const check = await client.query(`SELECT (SELECT paused_at IS NOT NULL FROM public.community_control WHERE id=1) AS paused,
      (SELECT count(*) FROM public.session) AS sessions, (SELECT count(*) FROM public.verification) AS otp,
      (SELECT count(*) FROM public.agent_tokens WHERE revoked_at IS NULL) AS agents,
      (SELECT count(*) FROM public.invitations WHERE revoked_at IS NULL) AS invitations`);
    const status = check.rows[0];
    if (!status?.paused || [status.sessions, status.otp, status.agents, status.invitations].some(value => Number(value) !== 0)) throw fail();
    await client.query("COMMIT");
  } catch {
    await client.query("ROLLBACK");
    throw fail();
  }
}

async function isolatedEmptyTarget(client: Client) {
  const listening = await client.query("SHOW listen_addresses");
  if (!String(listening.rows[0]?.listen_addresses).split(",").every(host => ["127.0.0.1", "::1", "localhost"].includes(host.trim()))) throw fail();
  const active = await client.query("SELECT count(*)::integer AS count FROM pg_stat_activity WHERE datname = current_database()");
  if (active.rows[0]?.count !== 1) throw fail();
  const objects = await client.query(`SELECT count(*)::integer AS count FROM (
    SELECT nspname FROM pg_namespace WHERE nspname NOT IN ('public', 'pg_catalog', 'information_schema') AND nspname NOT LIKE 'pg_toast%' AND nspname NOT LIKE 'pg_temp_%'
    UNION ALL SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
    UNION ALL SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
    UNION ALL SELECT t.typname FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public'
  ) AS objects`);
  if (objects.rows[0]?.count !== 0) throw fail();
  // PostgreSQL's default empty public schema conflicts with the archived CREATE SCHEMA.
  await client.query("DROP SCHEMA IF EXISTS public");
}

export async function restoreBackup(config: BackupConfig, key: Buffer, id: string, mode: "current" | "historical-offline" = "current") {
  if (!config.restoreEnvFile || !config.ledgerFile) throw fail();
  const source = await connectionFromFile(config.sourceEnvFile, "source");
  const target = await connectionFromFile(config.restoreEnvFile, "restore");
  if (source.hostname.replace(/^\[|\]$/g, "") === target.hostname.replace(/^\[|\]$/g, "") && (source.port || "5432") === (target.port || "5432")) throw fail();
  const executable = await postgresBinary(config.postgresBinDir, "pg_restore");
  const temp = await mkdtemp(path.join(config.backupDir, ".restore-"));
  try {
    const archive = path.join(temp, "archive.dump");
    const manifest = await decryptBundle(config.backupDir, id, key, archive);
    if (manifest.header.kind !== "database") throw fail();
    const ledger = validateLedger(JSON.parse((await readPrivate(config.ledgerFile, true, 32 * 1024 * 1024)).toString("utf8")), manifest.header, Date.now(), mode);
    // Node pg uses its own verified TLS handling for verify-full; no global TLS override.
    const client = new Client({ connectionString: target.toString(), connectionTimeoutMillis: 15_000, statement_timeout: 30_000, application_name: "kima-restore-gate" });
    client.on("error", () => {});
    try {
      await client.connect();
      await isolatedEmptyTarget(client);
    } finally { await client.end(); }
    const process = postgresProcess(executable, ["--exit-on-error", "--single-transaction", "--no-owner", "--no-privileges", "--dbname", decodeURIComponent(target.pathname.slice(1)), archive], target, config.postgresBinDir);
    process.child.stdout.resume();
    await process.done;
    const restored = new Client({ connectionString: target.toString(), connectionTimeoutMillis: 15_000, statement_timeout: 30_000, application_name: "kima-restore-harden" });
    restored.on("error", () => {});
    try { await restored.connect(); await hardenRestore(restored, ledger); } finally { await restored.end(); }
    return { id, paused: true, ledgerApplied: true, reviewedThrough: ledger.reviewedThrough, productionReady: false,
      ...(mode === "historical-offline" ? { ledgerTailUnknown: true } : {}) };
  } finally {
    // OS deletion is not a cryptographic erase (SSD/snapshots); use an encrypted host volume.
    await rm(temp, { recursive: true, force: true });
  }
}
