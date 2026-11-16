import nodemailer from "nodemailer";
import { database } from "@/lib/db";
import { inspectBackup, validCronAuthorization } from "@/lib/backup-monitor";
import { maintainExpiredAuth } from "@/lib/auth-maintenance";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const headers = { "Cache-Control": "private, no-store" };
export async function GET(request: Request) {
  if (!validCronAuthorization(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return Response.json({ error: "Nicht autorisiert." }, { status: 401, headers });
  }
  let result = { healthy: false, alerted: false };
  try {
    result = await inspectBackup({
      read: async () => (await database().query("SELECT backup_id, last_verified_at FROM public.backup_health WHERE id=1")).rows[0],
      alert: async reason => {
        if (!process.env.OPS_ALERT_EMAIL || !process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS || !process.env.SMTP_FROM) throw new Error("Missing alert configuration");
        const transport = nodemailer.createTransport({
          host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587),
          secure: process.env.SMTP_SECURE === "true", requireTLS: process.env.SMTP_SECURE !== "true",
          auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
          connectionTimeout: 10_000, socketTimeout: 15_000,
        });
        try {
          await transport.sendMail({ from: process.env.SMTP_FROM, to: process.env.OPS_ALERT_EMAIL,
            subject: "KIMA Community 7: Sicherung prüfen",
            text: `${reason}\n\nBitte die Actions-Läufe im privaten GitHub-Projekt kima-community-7 prüfen. Archive laufen nach sieben Tagen ab. Keine Produktion automatisch wiederherstellen oder alte Inhalte freigeben.\n\nDiese Warnung kommt von der täglichen Vercel-Prüfung. Bei gleichzeitigem Vercel- oder E-Mail-Ausfall ist keine Zustellung garantiert.`,
          });
        } finally { transport.close(); }
      },
    });
  } catch {
    console.error("KIMA Sicherungsüberwachung fehlgeschlagen; keine Alarmzustellung bestätigt.");
  }
  let maintenanceOk = false;
  try {
    await maintainExpiredAuth(database());
    maintenanceOk = true;
  } catch {
    console.error("KIMA Bereinigung abgelaufener Anmeldedaten fehlgeschlagen.");
  }
  return Response.json({ ...result, maintenanceOk }, { status: result.healthy && maintenanceOk ? 200 : 503, headers });
}
