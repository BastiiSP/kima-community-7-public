import { randomUUID } from "node:crypto";
import { transaction } from "./db";
import { ApiError } from "./errors";
import { handle, json } from "./http";
import { actor, authorizeMutation } from "./identity";
import { contentSchema, idSchema, readJson, throttle } from "./security";

export async function createContent(request: Request, postId?: string) {
  return handle(async () => {
    const identity = await actor(request);
    await throttle(`content:${identity.member.id}`, 30);
    await throttle(`content:daily:${identity.member.id}`, 300, 86400);
    const { body } = await readJson(request, contentSchema);
    const id = randomUUID();
    if (postId !== undefined) {
      if (!idSchema.safeParse(postId).success) throw new ApiError(400, "Ungültige Kennung.");
      await transaction(async client => {
        await authorizeMutation(client, identity);
        const parent = await client.query("SELECT id FROM posts WHERE id = $1 AND deleted_at IS NULL FOR UPDATE", [postId]);
        if (!parent.rowCount) throw new ApiError(404, "Beitrag nicht gefunden oder gelöscht.");
        const count = await client.query("SELECT count(*)::integer AS count FROM comments WHERE post_id = $1", [postId]);
        if (count.rows[0].count >= 100) throw new ApiError(409, "Dieser Beitrag hat die maximale Anzahl von 100 Antworten erreicht.");
        await client.query("INSERT INTO comments (id, post_id, author_id, body) VALUES ($1, $2, $3, $4)", [id, postId, identity.member.id, body]);
      });
    } else {
      await transaction(async client => {
        await authorizeMutation(client, identity);
        await client.query("INSERT INTO posts (id, author_id, body) VALUES ($1, $2, $3)", [id, identity.member.id, body]);
      });
    }
    return json({ id }, 201);
  });
}

export async function changeContent(request: Request, id: string, kind: "post" | "comment") {
  return handle(async () => {
    const identity = await actor(request);
    await throttle(`content:${identity.member.id}`, 30);
    if (!idSchema.safeParse(id).success) throw new ApiError(400, "Ungültige Kennung.");
    const table = kind === "post" ? "posts" : "comments"; // Closed enum, never request-provided SQL.
    const active = kind === "post" ? " AND deleted_at IS NULL" : "";
    const input = request.method === "PATCH" ? await readJson(request, contentSchema) : null;
    const result = await transaction(async client => {
      await authorizeMutation(client, identity);
      if (input) {
        const { body } = input;
        return client.query(`UPDATE ${table} SET body = $1, updated_at = now() WHERE id = $2 AND author_id = $3${active} RETURNING id`, [body, id, identity.member.id]);
      } else if (kind === "post") {
        // Do not delete comments belonging to other members along with a parent post.
        return client.query("UPDATE posts SET body = '', deleted_at = now(), updated_at = now() WHERE id = $1 AND author_id = $2 AND deleted_at IS NULL RETURNING id", [id, identity.member.id]);
      } else {
        return client.query("DELETE FROM comments WHERE id = $1 AND author_id = $2 RETURNING id", [id, identity.member.id]);
      }
    });
    if (!result.rowCount) throw new ApiError(404, "Eigener Inhalt nicht gefunden.");
    return json({ ok: true });
  });
}
