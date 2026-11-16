import { withAuthAccess, requireUnblockedEmail } from "@/lib/access";
import { z } from "zod";
import { getAuth } from "@/lib/auth";
import { handle, json } from "@/lib/http";
import { readJson, requireOrigin, throttle, authEntranceLimit } from "@/lib/security";

export const runtime = "nodejs";
const email = z.string().email().max(254).transform(value => value.toLowerCase());
const sendSchema = z.object({ email, type: z.literal("sign-in") }).strict();
const signInSchema = z.object({ email, otp: z.string().regex(/^\d{6}$/) }).strict();
const emptySchema = z.object({}).strict();

function run(request: Request) {
  return handle(async () => {
    const path = new URL(request.url).pathname.replace(/^\/api\/auth/, "");
    const allowedGet = request.method === "GET" && path === "/get-session";
    const allowedPost = request.method === "POST" && ["/sign-out", "/email-otp/send-verification-otp", "/sign-in/email-otp"].includes(path);
    if (!allowedGet && !allowedPost) return json({ error: "Nicht verfügbar." }, 404);
    if (request.headers.has("authorization")) return json({ error: "Hier ist eine persönliche Anmeldung erforderlich." }, 403);
    if (allowedPost) requireOrigin(request);
    await authEntranceLimit(request, path);
    let forwarded = request;
    if (allowedPost) {
      const data = path === "/email-otp/send-verification-otp" ? await readJson(request, sendSchema)
        : path === "/sign-in/email-otp" ? await readJson(request, signInSchema)
        : await readJson(request, emptySchema);
      // Recipient limit cannot be bypassed by choosing a different proxy/IP header.
      if ("email" in data) await throttle(`auth:${path}:${data.email}`, path.includes("send-verification") ? 5 : 10, 600);
      const headers = new Headers(request.headers);
      headers.delete("content-length");
      forwarded = new Request(request.url, { method: "POST", headers, body: JSON.stringify(data) });
    }
    const response = await withAuthAccess(async client => {
      if (allowedPost && path !== "/sign-out") {
        const data = await forwarded.clone().json() as { email: string };
        await requireUnblockedEmail(client, data.email);
      }
      const authResponse = await getAuth().handler(forwarded);
      if (allowedGet && authResponse.ok) {
        const session = await authResponse.clone().json() as { user?: { email?: string } } | null;
        if (session?.user?.email) await requireUnblockedEmail(client, session.user.email);
      }
      return authResponse;
    }, path === "/sign-out");
    response.headers.set("Cache-Control", "private, no-store");
    response.headers.set("Vary", "Cookie, Authorization");
    return response;
  });
}
export const GET = run;
export const POST = run;
