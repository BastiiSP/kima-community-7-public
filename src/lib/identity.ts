import type { PoolClient } from "pg";
import { requireAvailable, requireUnblockedEmail, withAuthAccess } from "./access";
import { getAuth } from "./auth";
import { authConfig } from "./config";
import { database } from "./db";
import { ApiError } from "./errors";
import { requireOrigin, entranceLimit } from "./security";

export type Member = { id: string; firstName: string; lastName: string };
export type Actor = { member: Member; sessionId: string };
export async function sessionUser(request: Request) {
  if (request.headers.has("authorization")) throw new ApiError(403, "Hier ist eine persönliche Anmeldung erforderlich.");
  return withAuthAccess(async client => {
    const session = await getAuth().api.getSession({ headers: request.headers });
    if (!session?.user || !session.user.emailVerified) throw new ApiError(401, "Bitte melde dich an.");
    await requireUnblockedEmail(client, session.user.email);
    return { ...session.user, sessionId: session.session.id };
  });
}
export async function actor(request: Request): Promise<Actor> {
  authConfig();
  await entranceLimit(request);
  await requireAvailable();
  if (request.headers.has("authorization")) throw new ApiError(403, "Hier ist eine persönliche Anmeldung erforderlich.");
  if (!["GET", "HEAD"].includes(request.method)) requireOrigin(request);
  const user = await sessionUser(request);
  const result = await database().query<Member & { blockedAt: string | null }>('SELECT id, first_name AS "firstName", last_name AS "lastName", blocked_at AS "blockedAt" FROM members WHERE user_id = $1', [user.id]);
  if (result.rows[0]?.blockedAt) throw new ApiError(403, "Dieser Zugang ist gesperrt. Bitte kontaktiere den Betreiber.", "MEMBER_BLOCKED");
  if (!result.rows[0]) throw new ApiError(403, "Du benötigst eine Einladung, um der Community beizutreten.");
  const { id, firstName, lastName } = result.rows[0];
  return { member: { id, firstName, lastName }, sessionId: user.sessionId };
}

// Recheck the exact credential after acquiring locks; a prior actor lookup is
// insufficient when an operator revoked access while the body was arriving.
export async function authorizeMutation(client: PoolClient, identity: Actor) {
  await requireAvailable(client);
  const member = await client.query("SELECT user_id FROM members WHERE id = $1 AND blocked_at IS NULL FOR UPDATE", [identity.member.id]);
  if (!member.rowCount) throw new ApiError(403, "Dieser Zugang ist nicht mehr verfügbar.", "MEMBER_BLOCKED");
  const credential = await client.query('SELECT id FROM session WHERE id = $1 AND "userId" = $2 AND "expiresAt" > now()', [identity.sessionId, member.rows[0].user_id]);
  if (!credential.rowCount) throw new ApiError(401, "Dieser Zugang wurde widerrufen. Bitte melde dich erneut an.");
}
