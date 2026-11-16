import { Pool, type PoolClient } from "pg";
import { ApiError } from "./errors";
import { databaseUrl } from "./config";

const state = globalThis as typeof globalThis & { communityPool?: Pool };
export function database(): Pool {
  if (!process.env.DATABASE_URL) throw new ApiError(503, "Die Datenbank ist noch nicht eingerichtet.");
  if (!state.communityPool) {
    state.communityPool = new Pool({ connectionString: databaseUrl(), max: 3, connectionTimeoutMillis: 8000, idleTimeoutMillis: 20000, statement_timeout: 10000 });
    // Do not log connection strings or SQL parameters on background connection failures.
    state.communityPool.on("error", () => console.error("Datenbankverbindung unterbrochen."));
  }
  return state.communityPool;
}

export async function transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
