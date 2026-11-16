import { requireAvailable } from "@/lib/access";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { transaction } from "@/lib/db";
import { ApiError } from "@/lib/errors";
import { handle, json } from "@/lib/http";
import { sessionUser } from "@/lib/identity";
import { hashToken, nameSchema, readJson, requireOrigin, throttle, tokenSchema, entranceLimit } from "@/lib/security";

export const runtime = "nodejs";
export async function POST(request: Request) {
  return handle(async () => {
    requireOrigin(request);
    await entranceLimit(request);
    const user = await sessionUser(request);
    await throttle(`join:${user.id}`, 10, 600);
    const input = await readJson(request, z.object({ token: tokenSchema, firstName: nameSchema, lastName: nameSchema }).strict());
    const member = await transaction(async client => {
      await requireAvailable(client);
      // Serialize joins for this user and lock the invitation until membership is committed.
      const account = await client.query('SELECT id FROM "user" WHERE id = $1 FOR UPDATE', [user.id]);
      const session = await client.query('SELECT id FROM session WHERE id = $1 AND "userId" = $2 AND "expiresAt" > now()', [user.sessionId, user.id]);
      if (!account.rowCount || !session.rowCount) throw new ApiError(401, "Bitte melde dich erneut an.");
      const existing = await client.query("SELECT id FROM members WHERE user_id = $1", [user.id]);
      if (existing.rowCount) throw new ApiError(409, "Du bist bereits Mitglied.");
      const invitation = await client.query("SELECT id FROM invitations WHERE token_hash = $1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now() AND (created_by IS NULL OR EXISTS (SELECT 1 FROM members WHERE members.id = invitations.created_by AND members.blocked_at IS NULL)) FOR UPDATE", [hashToken(input.token)]);
      if (!invitation.rowCount) throw new ApiError(400, "Diese Einladung ist ungültig, abgelaufen oder bereits verwendet.");
      const id = randomUUID();
      await client.query("INSERT INTO members (id, user_id, first_name, last_name) VALUES ($1, $2, $3, $4)", [id, user.id, input.firstName, input.lastName]);
      await client.query("UPDATE invitations SET used_at = now(), used_by = $1 WHERE id = $2", [id, invitation.rows[0].id]);
      return { id, firstName: input.firstName, lastName: input.lastName };
    });
    return json({ member }, 201);
  });
}
