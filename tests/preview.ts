// Local-only preview using ephemeral test services. No cloud data or real email.
import { testRuntime } from "./helpers/runtime";
const runtime = await testRuntime();
const email = "vorschau@example.test";
const cookie = await runtime.login(email);
async function post(path: string, body?: object) {
  const response = await fetch(runtime.origin + path, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: runtime.origin, Cookie: cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Preview setup failed: ${response.status}`);
  return response.json();
}
await post("/api/join", { token: await runtime.bootstrapInvite(), firstName: "Alex", lastName: "Beispiel" });
const first = await post("/api/posts", { body: "Willkommen in unserer Runde! 👋\n\nHier ist Platz für eure Fragen, Erfahrungen und kleinen Aha-Momente – auch nach der Ausbildung.\n\nDies ist eine lokale Vorschau mit Beispieldaten. Probiert gern einen eigenen Beitrag aus." });
await post(`/api/posts/${first.id}/comments`, { body: "Schön, dass wir hier auch nach dem Abschluss in Kontakt bleiben können." });
await post("/api/posts", { body: "Welche KI-Anwendung hat euch diese Woche wirklich geholfen?\n\nBei mir war es das Strukturieren meiner Lernnotizen. Mich interessiert: Was funktioniert bei euch im Alltag?" });
await post("/api/chat", { body: "Hallo zusammen! Hier können wir uns kurz austauschen – die Pinnwand bleibt für längere Beiträge." });
console.log(`VORSCHAU_URL=${runtime.origin}`);
console.log(`TEST_EMAIL=${email}`);
let previous = runtime.otpFor(email);
const timer = setInterval(() => {
  const otp = runtime.otpFor(email);
  if (otp && otp !== previous) { previous = otp; console.log(`VORSCHAU_ANMELDECODE=${otp}`); }
}, 500);
async function stop() { clearInterval(timer); await runtime.close(); process.exit(0); }
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
