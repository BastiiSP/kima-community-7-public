import { randomUUID } from "node:crypto";
import { chatPage } from "@/lib/chat";
import { database, transaction } from "@/lib/db";
import { handle, json } from "@/lib/http";
import { actor, authorizeMutation } from "@/lib/identity";
import { contentSchema, readJson, throttle } from "@/lib/security";

export const runtime = "nodejs";
export async function GET(request: Request) {
  return handle(async () => {
    const identity = await actor(request);
    await throttle(`chat:read:${identity.member.id}`, 60);
    const { before, after } = chatPage(request);
    // The comparator and sort order are selected solely from these closed cases.
    const comparison = after !== null ? ">" : "<";
    const order = after !== null ? "ASC" : "DESC";
    // Read messages and the deletion revision in one snapshot. Clients discard
    // their loaded history when the revision changes, including on empty polls.
    const result = await database().query(`SELECT deletion_revision::text AS revision,
      COALESCE((SELECT json_agg(message) FROM (SELECT c.id, c.body, c.author_id AS "authorId",
      m.first_name || ' ' || m.last_name AS "authorName", c.created_at AS "createdAt", c.position::text AS cursor
      FROM chat_messages c JOIN members m ON m.id = c.author_id
      WHERE ($1::bigint IS NULL OR c.position ${comparison} $1::bigint)
      ORDER BY c.position ${order} LIMIT 51) message), '[]') AS messages
      FROM chat_control WHERE id = 1`, [after ?? before]);
    const snapshot = result.rows[0];
    const rows = snapshot.messages as { id: string; body: string; authorId: string; authorName: string; createdAt: string; cursor: string }[];
    const page = rows.slice(0, 50);
    const messages = after !== null ? page : page.reverse();
    return json({ messages, revision: snapshot.revision,
      olderCursor: after === null && rows.length > 50 ? messages[0].cursor : null,
      newerCursor: messages.at(-1)?.cursor ?? after ?? "0",
      hasMore: after !== null && rows.length > 50 });
  });
}

export async function POST(request: Request) {
  return handle(async () => {
    const identity = await actor(request);
    await throttle(`content:${identity.member.id}`, 30);
    await throttle(`content:daily:${identity.member.id}`, 300, 86400);
    const { body } = await readJson(request, contentSchema);
    const result = await transaction(async client => {
      await authorizeMutation(client, identity);
      // Serialize allocation through commit, so a later visible cursor cannot
      // overtake an earlier uncommitted message. Reads remain nonblocking.
      await client.query("LOCK TABLE chat_messages IN SHARE ROW EXCLUSIVE MODE");
      return client.query(`INSERT INTO chat_messages (id, author_id, body) VALUES ($1, $2, $3)
        RETURNING id, body, author_id AS "authorId", created_at AS "createdAt", position::text AS cursor`,
      [randomUUID(), identity.member.id, body]);
    });
    return json({ message: { ...result.rows[0], authorName: `${identity.member.firstName} ${identity.member.lastName}` } }, 201);
  });
}
