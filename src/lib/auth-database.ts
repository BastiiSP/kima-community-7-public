import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { database } from "./db";

type Scope = {
  client: PoolClient;
  active: boolean;
  failed: boolean;
  busy: boolean;
  queue: Promise<void>;
  releaseLease?: () => void;
  sequence: number;
};
const storage = new AsyncLocalStorage<Scope>();

// Better Auth's default storage catches a competing first INSERT, but that
// unique violation aborts our outer PostgreSQL transaction. Consume atomically
// without throwing, retaining its rolling-window rules and transaction scope.
export async function consumeAuthRateLimit(key: string, rule: { window: number; max: number }) {
  const client = await acquire();
  try {
    const allowed = await client.query(`INSERT INTO "rateLimit" (id, key, count, "lastRequest")
      VALUES ($1, $2, 1, floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint)
      ON CONFLICT (key) DO UPDATE SET
        count = CASE WHEN "rateLimit"."lastRequest" <= EXCLUDED."lastRequest" - $3 THEN 1 ELSE "rateLimit".count + 1 END,
        "lastRequest" = GREATEST("rateLimit"."lastRequest", EXCLUDED."lastRequest")
      WHERE "rateLimit"."lastRequest" <= EXCLUDED."lastRequest" - $3 OR "rateLimit".count < $4
      RETURNING id`, [randomUUID(), key, rule.window * 1000, rule.max]);
    if (allowed.rowCount) return { allowed: true, retryAfter: null };
    const denied = await client.query(`SELECT GREATEST(1, ceil(("lastRequest" + $2 - extract(epoch FROM clock_timestamp()) * 1000) / 1000))::int AS retry
      FROM "rateLimit" WHERE key = $1`, [key, rule.window * 1000]);
    return { allowed: false, retryAfter: denied.rows[0]?.retry ?? rule.window };
  } finally { client.release(); }
}

// Better Auth/Kysely must participate in the very transaction holding the gate.
// This works with transaction-pooled Neon and PGlite's single backend alike.
export async function withAuthDatabase<T>(client: PoolClient, work: () => Promise<T>) {
  const scope: Scope = { client, active: true, failed: false, busy: false, queue: Promise.resolve(), sequence: 0 };
  try {
    return await storage.run(scope, async () => {
      const result = await work();
      if (scope.failed || scope.busy) throw new Error("Authentication database scope did not finish cleanly.");
      return result;
    });
  } finally {
    scope.active = false;
    scope.releaseLease?.();
  }
}

async function acquire() {
  const scope = storage.getStore();
  if (!scope?.active) throw new Error("Authentication database requires an active access transaction.");
  const previous = scope.queue;
  let unlock!: () => void;
  scope.queue = new Promise<void>(resolve => { unlock = resolve; });
  await previous;
  if (!scope.active) { unlock(); throw new Error("Authentication database scope is closed."); }
  scope.busy = true;
  scope.releaseLease = unlock;
  let released = false;
  let savepoint: string | null = null;
  const query = async (sql: string, parameters?: unknown[]) => {
    if (released || !scope.active) throw new Error("Authentication database lease is closed.");
    if (typeof sql !== "string") throw new Error("Unsupported authentication database query.");
    const command = sql.trim().toLowerCase();
    if (command === "begin") {
      if (savepoint) throw new Error("Nested authentication transaction is unsupported.");
      savepoint = `auth_scope_${++scope.sequence}`;
      return scope.client.query(`SAVEPOINT ${savepoint}`);
    }
    if (command.startsWith("start transaction") || command.startsWith("begin ")) throw new Error("Unsupported authentication transaction settings.");
    if (command === "commit" || command === "rollback") {
      if (!savepoint) throw new Error("Authentication transaction has no savepoint.");
      const name = savepoint;
      if (command === "rollback") await scope.client.query(`ROLLBACK TO SAVEPOINT ${name}`);
      const result = await scope.client.query(`RELEASE SAVEPOINT ${name}`);
      savepoint = null;
      return result;
    }
    return scope.client.query(sql, parameters);
  };
  return new Proxy(scope.client, { get(target, property) {
    if (property === "query") return query;
    if (property === "release") return (discard?: boolean | Error) => {
      if (released) return;
      released = true;
      if (discard || savepoint) scope.failed = true;
      scope.busy = false;
      scope.releaseLease = undefined;
      unlock();
    };
    const value = Reflect.get(target, property);
    return typeof value === "function" ? value.bind(target) : value;
  } });
}

export function authDatabase() {
  return new Proxy(database(), { get(target, property) {
    if (property === "connect") return acquire;
    // Kysely uses connect/query/release on the leased client, never pool.query.
    // Reject unexpected future adapter behavior rather than escaping the gate.
    if (property === "query" || property === "end") return () => { throw new Error("Unsupported authentication pool operation."); };
    const value = Reflect.get(target, property);
    return typeof value === "function" ? value.bind(target) : value;
  } });
}
