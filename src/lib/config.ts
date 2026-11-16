import { ApiError } from "./errors";

export function appOrigin() {
  try {
    const url = new URL(process.env.BETTER_AUTH_URL ?? "");
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error();
    if (url.protocol !== "https:" && !(process.env.NODE_ENV !== "production" && url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) throw new Error();
    return url.origin;
  } catch {
    throw new ApiError(503, "Die Community ist noch nicht vollständig eingerichtet.");
  }
}

export function insecureDevelopmentSmtp() {
  return process.env.NODE_ENV !== "production" && process.env.SMTP_ALLOW_INSECURE === "true";
}

export function authConfig() {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret || secret.length < 32 || /replace-with|change.?me|example/i.test(secret) || !process.env.DATABASE_URL || !process.env.SMTP_HOST || !process.env.SMTP_FROM || (!insecureDevelopmentSmtp() && (!process.env.SMTP_USER || !process.env.SMTP_PASS))) {
    throw new ApiError(503, "Die Community ist noch nicht vollständig eingerichtet.");
  }
  return { secret, baseURL: appOrigin() };
}

export function databaseUrl() {
  const value = process.env.DATABASE_URL;
  try {
    const url = new URL(value ?? "");
    if (!["postgres:", "postgresql:"].includes(url.protocol)) throw new Error();
    if ([...url.searchParams.keys()].some(key => url.searchParams.getAll(key).length !== 1)) throw new Error();
    if (process.env.NODE_ENV === "production" && (url.searchParams.get("sslmode") !== "verify-full" || url.searchParams.get("ssl") === "false" || process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0")) throw new Error();
    return value!;
  } catch { throw new ApiError(503, "Die Datenbank ist noch nicht sicher eingerichtet."); }
}
