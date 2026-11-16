import { timingSafeEqual } from "node:crypto";

export function validCronAuthorization(header: string | null, secret: string | undefined) {
  if (!secret || secret.length < 32 || !header) return false;
  const expected = Buffer.from(`Bearer ${secret}`), supplied = Buffer.from(header);
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}

export function backupIsCurrent(row: { backup_id: unknown; last_verified_at: unknown } | undefined, now = Date.now()) {
  if (!row || typeof row.backup_id !== "string" || !/^database-\d{8}T\d{6}Z-[a-f0-9-]{36}$/.test(row.backup_id)) return false;
  const time = row.last_verified_at instanceof Date ? row.last_verified_at.getTime() : Date.parse(String(row.last_verified_at));
  return Number.isFinite(time) && time <= now + 60_000 && time >= now - 26 * 60 * 60_000;
}

export async function inspectBackup(dependencies: {
  read: () => Promise<{ backup_id: unknown; last_verified_at: unknown } | undefined>;
  alert: (reason: string) => Promise<void>;
  now?: number;
}) {
  let reason = "";
  try { if (!backupIsCurrent(await dependencies.read(), dependencies.now)) reason = "Es liegt keine bestätigte externe Sicherung mit Wiederherstellungstest aus den letzten 26 Stunden vor."; }
  catch { reason = "Der Sicherungsstatus ist nicht abrufbar. Auch die Datenbank oder ihr Gratislimit kann betroffen sein."; }
  if (reason) { await dependencies.alert(reason); return { healthy: false, alerted: true }; }
  return { healthy: true, alerted: false };
}
