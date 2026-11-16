// Operator scripts must validate TLS even when NODE_ENV was not set by a shell.
export function operatorDatabaseUrl() {
  try {
    const value = process.env.DATABASE_URL;
    const url = new URL(value ?? "");
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) && process.env.NODE_ENV !== "production";
    // Strict allowlist: pg permits query parameters such as host to override the
    // URL authority. Reject all aliases that could bypass the loopback/TLS check.
    const allowed = new Set(["sslmode", "channel_binding", "application_name"]);
    if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || !url.pathname.slice(1)
      || /[%/\\]/.test(url.hostname) || url.hash || [...url.searchParams.keys()].some(key => !allowed.has(key) || url.searchParams.getAll(key).length !== 1)
      || process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0"
      || (!local && url.searchParams.get("sslmode") !== "verify-full")
      || (local && url.searchParams.has("sslmode") && !["disable", "verify-full"].includes(url.searchParams.get("sslmode")!))) {
      throw new Error("database");
    }
    return value!;
  } catch { throw new Error("Datenbankverbindung ist nicht sicher konfiguriert."); }
}
