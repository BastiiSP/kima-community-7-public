import { randomUUID } from "node:crypto";
import { appOrigin } from "@/lib/config";
import { transaction } from "@/lib/db";
import { handle, json } from "@/lib/http";
import { actor, authorizeMutation } from "@/lib/identity";
import { hashToken, newToken, throttle } from "@/lib/security";

export const runtime = "nodejs";
export async function POST(request: Request) {
  return handle(async () => {
    const identity = await actor(request);
    await throttle(`invite:${identity.member.id}`, 10, 86400);
    const token = newToken();
    const result = await transaction(async client => {
      await authorizeMutation(client, identity);
      return client.query("INSERT INTO invitations (id, token_hash, created_by, expires_at) VALUES ($1, $2, $3, now() + interval '7 days') RETURNING expires_at", [randomUUID(), hashToken(token), identity.member.id]);
    });
    return json({ url: `${appOrigin()}/#invite=${token}`, expiresAt: result.rows[0].expires_at }, 201);
  });
}
