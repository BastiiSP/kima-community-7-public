import { ApiError } from "./errors";

export function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "private, no-store", "Vary": "Cookie, Authorization", "X-Content-Type-Options": "nosniff" } });
}
export async function handle(work: () => Promise<Response>): Promise<Response> {
  try { return await work(); }
  catch (error) {
    if (error instanceof ApiError) return json({ error: error.message, ...(error.code ? { code: error.code } : {}) }, error.status);
    console.error("Community-Anfrage fehlgeschlagen.");
    return json({ error: "Der Dienst ist vorübergehend nicht verfügbar. Bitte versuche es später erneut." }, 503);
  }
}
