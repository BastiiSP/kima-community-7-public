import { transaction } from "@/lib/db";
import { ApiError } from "@/lib/errors";
import { handle, json } from "@/lib/http";
import { actor, authorizeMutation } from "@/lib/identity";
import { idSchema, throttle } from "@/lib/security";

export const runtime = "nodejs";
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const identity = await actor(request);
    await throttle(`content:${identity.member.id}`, 30);
    const { id } = await context.params;
    if (!idSchema.safeParse(id).success) throw new ApiError(400, "Ungültige Kennung.");
    const result = await transaction(async client => {
      await authorizeMutation(client, identity);
      const deleted = await client.query("DELETE FROM chat_messages WHERE id = $1 AND author_id = $2 RETURNING id", [id, identity.member.id]);
      if (deleted.rowCount) await client.query("UPDATE chat_control SET deletion_revision = deletion_revision + 1 WHERE id = 1");
      return deleted;
    });
    if (!result.rowCount) throw new ApiError(404, "Eigene Nachricht nicht gefunden.");
    return json({ ok: true });
  });
}
