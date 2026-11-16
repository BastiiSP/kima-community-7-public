import { createHash, randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { z } from "zod";
import { appOrigin } from "./config";
import { database } from "./db";
import { ApiError } from "./errors";

export const contentSchema = z.object({ body: z.string().trim().min(1, "Bitte Text eingeben.").max(5000, "Maximal 5.000 Zeichen erlaubt.").refine(value => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value), "Ungültige Steuerzeichen.") }).strict();
export const nameSchema = z.string().trim().min(1).max(80).refine(value => !/[\u0000-\u001f\u007f]/.test(value), "Ungültiger Name.");
export const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const idSchema = z.string().uuid();
export function hashToken(token: string) { return createHash("sha256").update(token).digest("hex"); }
export function newToken() { return randomBytes(32).toString("base64url"); }
export function requireOrigin(request: Request) {
  if (request.headers.get("origin") !== appOrigin()) throw new ApiError(403, "Diese Anfrage stammt nicht von der Community.");
}

export async function readJson<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") throw new ApiError(415, "JSON wird erwartet.");
  const limit = 24000;
  if (Number(request.headers.get("content-length")) > limit) throw new ApiError(413, "Die Anfrage ist zu groß.");
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError(400, "Der Anfrageinhalt fehlt.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; void reader.cancel().catch(() => {}); }, 5000);
  try { while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) { void reader.cancel().catch(() => {}); throw new ApiError(413, "Die Anfrage ist zu groß."); }
    chunks.push(value);
  } } finally { clearTimeout(timeout); reader.releaseLock(); }
  if (timedOut) throw new ApiError(408, "Die Anfrage wurde nicht rechtzeitig übertragen.");
  let data: unknown;
  try { data = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new ApiError(400, "Ungültiges JSON."); }
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new ApiError(400, parsed.error.issues[0]?.message ?? "Ungültige Eingabe.");
  return parsed.data;
}

// Atomic consumption; bounded cleanup also removes abandoned recipient/IP buckets.
export async function throttle(key: string, limit: number, seconds = 60) {
  await database().query(`DELETE FROM app_rate_limits WHERE key IN
    (SELECT key FROM app_rate_limits WHERE expires_at <= now() LIMIT 100 FOR UPDATE SKIP LOCKED)`);
  const result = await database().query<{ hits: number }>(`
    INSERT INTO app_rate_limits (key, hits, expires_at) VALUES ($1, 1, now() + $2 * interval '1 second')
    ON CONFLICT (key) DO UPDATE SET
      hits = CASE WHEN app_rate_limits.expires_at <= now() THEN 1 ELSE LEAST(app_rate_limits.hits, $3) + 1 END,
      expires_at = CASE WHEN app_rate_limits.expires_at <= now() THEN now() + $2 * interval '1 second' ELSE app_rate_limits.expires_at END
    RETURNING hits`, [hashToken(key), seconds, limit]);
  if (result.rows[0].hits > limit) throw new ApiError(429, "Zu viele Anfragen. Bitte versuche es später erneut.");
}

export function clientBucket(request: Request) {
  // Only Vercel's platform-owned header is trusted; never arbitrary X-Forwarded-For.
  const ip = process.env.VERCEL === "1" ? request.headers.get("x-vercel-forwarded-for")?.trim() : null;
  if (!ip || !isIP(ip)) return "shared";
  if (isIP(ip) === 4) return ip;
  const canonical = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
  const [left, right] = canonical.split("::");
  const first = left ? left.split(":") : [];
  const last = right ? right.split(":") : [];
  const groups = right === undefined ? first : [...first, ...Array<string>(8 - first.length - last.length).fill("0"), ...last];
  if (groups.slice(0, 5).every(group => group === "0") && groups[5] === "ffff") {
    const high = parseInt(groups[6], 16), low = parseInt(groups[7], 16);
    return [high >> 8, high & 255, low >> 8, low & 255].join(".");
  }
  return groups.slice(0, 4).join(":") + "::/64";
}

export async function entranceLimit(request: Request) {
  await throttle(`entrance:${clientBucket(request)}`, 300);
  await throttle("entrance:global", 3000);
}

export async function authEntranceLimit(request: Request, path: string) {
  await entranceLimit(request);
  if (path === "/email-otp/send-verification-otp" || path === "/sign-in/email-otp") {
    const send = path.includes("send-verification");
    await throttle(`auth:ip:${path}:${clientBucket(request)}`, send ? 10 : 30, 600);
    await throttle(`auth:global:${path}`, send ? 100 : 500, 600);
  }
}
