import { database } from "@/lib/db";
import { handle, json } from "@/lib/http";
import { actor } from "@/lib/identity";
import { throttle } from "@/lib/security";
import { readCursor, cursorFor } from "@/lib/pagination";

export const runtime = "nodejs";
export async function GET(request: Request) {
  return handle(async () => {
    const identity = await actor(request);
    await throttle(`feed:${identity.member.id}`, 60);
    const cursor = readCursor(request);
    const result = await database().query(`SELECT p.id, p.body, p.author_id AS "authorId", COALESCE(m.first_name || ' ' || m.last_name, 'Gelöschtes Mitglied') AS "authorName",
      p.agent_name AS "agentName", p.created_at AS "createdAt", to_char(p.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursorAt", p.deleted_at IS NOT NULL AS deleted,
      COALESCE((SELECT json_agg(c ORDER BY c."createdAt", c.id) FROM (
        SELECT c.id, c.body, c.author_id AS "authorId", cm.first_name || ' ' || cm.last_name AS "authorName", c.agent_name AS "agentName", c.created_at AS "createdAt",
          to_char(c.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursorAt"
        FROM comments c JOIN members cm ON cm.id = c.author_id WHERE c.post_id = p.id ORDER BY c.created_at, c.id LIMIT 5
      ) c), '[]') AS comments,
      (SELECT count(*)::integer FROM comments c WHERE c.post_id = p.id) AS "commentCount"
      FROM posts p LEFT JOIN members m ON m.id = p.author_id
      WHERE ($1::timestamptz IS NULL OR (p.created_at, p.id) < ($1::timestamptz, $2::uuid))
      ORDER BY p.created_at DESC, p.id DESC LIMIT 11`, [cursor?.at ?? null, cursor?.id ?? null]);
    const posts = result.rows.slice(0, 10);
    const last = posts.at(-1);
    const nextCursor = result.rows.length > 10 && last ? cursorFor(last) : null;
    return json({ member: identity.member, posts: posts.map(({ cursorAt, ...post }) => {
      const comments = post.comments as { id: string; cursorAt: string }[];
      const lastComment = comments.at(-1);
      return { ...post, orderAt: cursorAt, commentsTruncated: post.commentCount > comments.length,
        commentsNextCursor: post.commentCount > comments.length && lastComment ? cursorFor(lastComment) : null,
        comments: comments.map(({ cursorAt, ...comment }) => { return { ...comment, orderAt: cursorAt }; }) };
    }), nextCursor });
  });
}
