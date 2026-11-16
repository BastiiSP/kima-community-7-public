import { createContent } from "@/lib/content";
import { actor } from "@/lib/identity";
import { handle, json } from "@/lib/http";
import { database } from "@/lib/db";
import { idSchema, throttle } from "@/lib/security";
import { readCursor, cursorFor } from "@/lib/pagination";
import { ApiError } from "@/lib/errors";
export const runtime = "nodejs";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) { return createContent(request, (await context.params).id); }
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const identity = await actor(request);
    await throttle(`feed:${identity.member.id}`, 60);
    const { id } = await context.params;
    if (!idSchema.safeParse(id).success) throw new ApiError(400, "Ungültige Kennung.");
    const cursor = readCursor(request);
    const parent = await database().query("SELECT id FROM posts WHERE id = $1", [id]);
    if (!parent.rowCount) throw new ApiError(404, "Beitrag nicht gefunden.");
    const result = await database().query(`SELECT c.id, c.body, c.author_id AS "authorId", m.first_name || ' ' || m.last_name AS "authorName",
      c.agent_name AS "agentName", c.created_at AS "createdAt",
      to_char(c.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursorAt"
      FROM comments c JOIN members m ON m.id = c.author_id WHERE c.post_id = $1
      AND ($2::timestamptz IS NULL OR (c.created_at, c.id) > ($2::timestamptz, $3::uuid))
      ORDER BY c.created_at, c.id LIMIT 21`, [id, cursor?.at ?? null, cursor?.id ?? null]);
    const comments = result.rows.slice(0, 20);
    const last = comments.at(-1);
    return json({ comments: comments.map(({ cursorAt, ...comment }) => { return { ...comment, orderAt: cursorAt }; }),
      nextCursor: result.rows.length > 20 && last ? cursorFor(last) : null });
  });
}
