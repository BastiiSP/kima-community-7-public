import { POST } from "../../src/app/api/auth/[...all]/route";
import { withAuthAccess } from "../../src/lib/access";
import { consumeAuthRateLimit } from "../../src/lib/auth-database";

// Separate processes deliberately have no shared Better Auth JavaScript locks.
// This fixture exercises the actual route and database adapter, not Next/Vercel.
process.on("message", async (message: { id: number; action: string; email?: string; otp?: string; key?: string }) => {
  try {
    let result: unknown;
    if (message.action === "verify") {
      const response = await POST(new Request(`${process.env.BETTER_AUTH_URL}/api/auth/sign-in/email-otp`, {
        method: "POST", headers: { Origin: process.env.BETTER_AUTH_URL!, "Content-Type": "application/json" },
        body: JSON.stringify({ email: message.email, otp: message.otp }),
      }));
      result = { status: response.status, cookies: response.headers.getSetCookie(), body: await response.json() };
    } else if (message.action === "consume" && message.key) {
      result = await withAuthAccess(() => consumeAuthRateLimit(message.key!, { window: 60, max: 3 }));
    } else throw new Error("Unknown synthetic worker action");
    process.send!({ id: message.id, result });
  } catch {
    process.send!({ id: message.id, error: "Synthetic auth worker failed" });
  }
});
process.send!({ ready: true });
