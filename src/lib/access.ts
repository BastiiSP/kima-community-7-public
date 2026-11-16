import type { PoolClient } from "pg";
import { database } from "./db";
import { withAuthDatabase } from "./auth-database";
import { ApiError } from "./errors";

// Lock order: control row, member/user, credential, content/invitation.
// Operators take an exclusive control lock; every mutation takes a shared lock.
export async function requireAvailable(client?: PoolClient) {
  const result = await (client ?? database()).query(`SELECT paused_at FROM community_control WHERE id = 1${client ? " FOR SHARE" : ""}`);
  if (!result.rowCount || result.rows[0].paused_at) throw new ApiError(503, "Die Community ist vorübergehend pausiert. Bitte versuche es später erneut.", "COMMUNITY_PAUSED");
}

// The entire auth request (including Better Auth's database work) uses one
// transaction/connection, so an operator can safely wait for all issued sessions.
export async function withAuthAccess<T>(work: (client: PoolClient) => Promise<T>, signOut = false): Promise<T> {
  const client = await database().connect();
  let discard = false;
  try {
    await client.query("BEGIN");
    if (signOut) await client.query("SELECT id FROM community_control WHERE id = 1 FOR SHARE");
    else await requireAvailable(client);
    const result = await withAuthDatabase(client, () => work(client));
    const commit = await client.query("COMMIT");
    if (commit.command === "ROLLBACK") throw new Error("Authentication transaction was rolled back.");
    return result;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { discard = true; }
    throw error;
  } finally { client.release(discard); }
}

export async function requireUnblockedEmail(client: PoolClient, email: string) {
  const blocked = await client.query('SELECT m.id FROM members m JOIN "user" u ON u.id = m.user_id WHERE lower(u.email) = $1 AND m.blocked_at IS NOT NULL', [email.toLowerCase()]);
  if (blocked.rowCount) throw new ApiError(403, "Dieser Zugang ist gesperrt. Bitte kontaktiere den Betreiber.", "MEMBER_BLOCKED");
}
