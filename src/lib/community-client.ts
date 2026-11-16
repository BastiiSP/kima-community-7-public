export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) { super(message); this.name = "ApiError"; }
}

export const REQUEST_TIMEOUT_MS = 15_000;

// Timers can be suspended with a browser tab. Recheck elapsed wall time when
// the page returns, and settle even if the underlying transport ignores abort.
async function withRequestDeadline<T>(work: (signal: AbortSignal) => Promise<T>, callerSignal?: AbortSignal | null): Promise<T> {
  const controller = new AbortController();
  const deadline = Date.now() + REQUEST_TIMEOUT_MS;
  const timeoutError = () => new ApiError("Die Anfrage dauert zu lange. Deine Eingabe bleibt erhalten. Bitte prüfe vor erneutem Senden, ob sie bereits angekommen ist.", 0, "REQUEST_TIMEOUT");
  let rejectAbort!: (error: unknown) => void;
  const interrupted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const abort = (error: Error) => { rejectAbort(error); controller.abort(error); };
  const cancel = () => abort(new DOMException("Die Anfrage wurde abgebrochen.", "AbortError"));
  const checkDeadline = () => { if (Date.now() >= deadline) abort(timeoutError()); };
  const timer = setTimeout(() => abort(timeoutError()), REQUEST_TIMEOUT_MS);
  callerSignal?.addEventListener("abort", cancel, { once: true });
  if (callerSignal?.aborted) cancel();
  if (typeof window !== "undefined") {
    window.addEventListener("focus", checkDeadline);
    window.addEventListener("pageshow", checkDeadline);
    document.addEventListener("visibilitychange", checkDeadline);
  }
  try {
    return await Promise.race([interrupted, (async () => {
      controller.signal.throwIfAborted();
      const result = await work(controller.signal);
      checkDeadline();
      controller.signal.throwIfAborted();
      return result;
    })()]);
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", cancel);
    if (typeof window !== "undefined") {
      window.removeEventListener("focus", checkDeadline);
      window.removeEventListener("pageshow", checkDeadline);
      document.removeEventListener("visibilitychange", checkDeadline);
    }
  }
}

// Better Auth supplies its own signal, which bypasses Better Fetch's timeout.
// Buffer these small JSON responses so the deadline includes the body as well.
export const authFetch: typeof fetch = (input, options) => withRequestDeadline(async signal => {
  const response = await fetch(input, { ...options, signal });
  const body = await response.arrayBuffer();
  return new Response(response.status === 204 || response.status === 205 || response.status === 304 ? null : body, {
    status: response.status, statusText: response.statusText, headers: response.headers,
  });
}, options?.signal ?? (input instanceof Request ? input.signal : undefined));

function readableError(status: number, fallback: string) {
  if (status === 401) return "Deine Sitzung ist abgelaufen. Bitte melde dich erneut an.";
  if (status === 403) return "Für diese Aktion fehlt dir die Berechtigung.";
  if (status === 503) return "Die Community ist vorübergehend nicht erreichbar. Bitte versuche es später erneut.";
  return fallback;
}

// One attempt only: a timed-out write may already have reached the server.
export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  try {
    return await withRequestDeadline(async signal => {
      const headers = new Headers(options?.headers);
      if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
      const response = await fetch(path, { cache: "no-store", ...options, headers, signal });
      let result: (T & { error?: string; code?: string }) | null;
      try { result = await response.json() as T & { error?: string; code?: string }; }
      catch (caught) { if (signal.aborted) throw caught; result = null; }
      if (!response.ok) throw new ApiError(result?.code === "COMMUNITY_PAUSED" || result?.code === "MEMBER_BLOCKED" ? result.error || "Zugang nicht verfügbar." : readableError(response.status, result?.error || "Die Anfrage konnte nicht abgeschlossen werden."), response.status, result?.code);
      if (result === null) throw new Error("Die Antwort konnte nicht gelesen werden. Bitte versuche es erneut.");
      return result;
    }, options?.signal);
  } catch (caught) {
    if (options?.signal?.aborted) throw new DOMException("Die Anfrage wurde abgebrochen.", "AbortError");
    if (caught instanceof ApiError || caught instanceof Error && caught.message.startsWith("Die Antwort")) throw caught;
    throw new Error("Die Verbindung ist gerade nicht erreichbar. Bitte versuche es erneut.");
  }
}
