import type { Pool } from "pg";

// Only expired access data is eligible; content, accounts and recovery journals stay intact.
export async function maintainExpiredAuth(pool: Pick<Pool, "connect">) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout = '3s'");
    await client.query("SET LOCAL lock_timeout = '1s'");
    const sessions = await client.query(`DELETE FROM public.session WHERE id IN (
      SELECT id FROM public.session WHERE "expiresAt" < CURRENT_TIMESTAMP
      ORDER BY "expiresAt", id LIMIT 100 FOR UPDATE SKIP LOCKED
    )`);
    const verifications = await client.query(`DELETE FROM public.verification WHERE id IN (
      SELECT id FROM public.verification WHERE "expiresAt" < CURRENT_TIMESTAMP
      ORDER BY "expiresAt", id LIMIT 100 FOR UPDATE SKIP LOCKED
    )`);
    const rateLimits = await client.query(`DELETE FROM public."rateLimit" WHERE id IN (
      SELECT id FROM public."rateLimit"
      WHERE "lastRequest" < floor(extract(epoch FROM CURRENT_TIMESTAMP - interval '24 hours') * 1000)
      ORDER BY "lastRequest", id LIMIT 100 FOR UPDATE SKIP LOCKED
    )`);
    await client.query("COMMIT");
    return { sessions: sessions.rowCount ?? 0, verifications: verifications.rowCount ?? 0, rateLimits: rateLimits.rowCount ?? 0 };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
