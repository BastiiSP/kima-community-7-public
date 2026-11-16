import { Client } from "pg";
import { z } from "zod";
import { type BackupConfig, connectionFromFile, fail } from "./backup-config";
import { decryptBundle } from "./backup-storage";
import { validateLedger, type RecoveryLedger } from "./backup-restore";

const backupSchema = z.object({ id: z.string().min(1), startedAt: z.iso.datetime() });
const fields = {
  member_block: "blockedMemberIds", member_delete: "deletedMemberIds", post_delete: "deletedPostIds",
  comment_delete: "deletedCommentIds", chat_delete: "deletedChatMessageIds",
} as const;

/** Dedicated backup connection only. Returns coverage through this snapshot, not
 * through a later outage/release. Never resumes a restored community. */
export async function exportRecoveryLedger(client: Pick<Client, "query">, backup: { id: string; startedAt: string }): Promise<RecoveryLedger> {
  backupSchema.parse(backup);
  await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
  try {
    await client.query("SET LOCAL lock_timeout = '30s'");
    await client.query("SET LOCAL statement_timeout = '30s'");
    // Owner-defined function waits for in-flight writes and returns one locked
    // snapshot; the dedicated backup role only needs EXECUTE, not DML rights.
    const result = await client.query("SELECT public.export_recovery_journal($1, $2::timestamptz) AS snapshot", [backup.id, backup.startedAt]);
    const state = result.rows[0]?.snapshot;
    if (result.rows.length !== 1 || !state) throw fail();
    const ledger: RecoveryLedger = {
      format: 1, backupId: backup.id, backupStartedAt: backup.startedAt,
      reviewedThrough: new Date(state.reviewed_through).toISOString(), complete: true,
      blockedMemberIds: [], deletedMemberIds: [], deletedPostIds: [], deletedCommentIds: [], deletedChatMessageIds: [],
    };
    // The persisted pre-dump lock boundary excludes safely committed earlier
    // edits. The short interval from boundary to pg_dump remains conservative.
    for (const entry of state.entries ?? []) {
      if (!Object.hasOwn(fields, entry.kind)) throw fail();
      ledger[fields[entry.kind as keyof typeof fields]].push(entry.entity_id);
    }
    validateLedger(ledger, backup);
    await client.query("COMMIT");
    return ledger;
  } catch {
    await client.query("ROLLBACK");
    throw fail();
  }
}

/** Authenticate the backup header first; a failed source connection never creates
 * a complete ledger. Caller persists/encrypts the returned IDs in private storage. */
export async function exportBackupLedger(config: BackupConfig, key: Buffer, id: string) {
  const manifest = await decryptBundle(config.backupDir, id, key);
  if (manifest.header.kind !== "database") throw fail();
  const source = await connectionFromFile(config.sourceEnvFile, "source");
  const client = new Client({ connectionString: source.toString(), connectionTimeoutMillis: 15_000,
    statement_timeout: 30_000, application_name: "kima-recovery-ledger" });
  client.on("error", () => {});
  try {
    await client.connect();
    return await exportRecoveryLedger(client, manifest.header);
  } catch { throw fail(); }
  finally { await client.end(); }
}
