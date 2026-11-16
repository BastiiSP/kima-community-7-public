import test from "node:test";
import assert from "node:assert/strict";
import { backupIsCurrent, inspectBackup, validCronAuthorization } from "../src/lib/backup-monitor";

const now = Date.parse("2026-11-16T20:00:00Z");
const id = "database-20261116T172300Z-10000000-0000-4000-8000-000000000001";
test("monitor rejects missing, invalid, stale and future status", () => {
  assert.equal(backupIsCurrent(undefined, now), false);
  assert.equal(backupIsCurrent({ backup_id: id, last_verified_at: new Date(now - 25 * 3600000) }, now), true);
  for (const value of ["garbage", new Date(now - 27 * 3600000), new Date(now + 120000)]) assert.equal(backupIsCurrent({ backup_id: id, last_verified_at: value }, now), false);
  assert.equal(backupIsCurrent({ backup_id: "invalid", last_verified_at: new Date(now) }, now), false);
});
test("monitor authorizes only exact configured secret", () => {
  const secret = "a".repeat(64);
  assert.equal(validCronAuthorization(`Bearer ${secret}`, secret), true);
  for (const header of [null, secret, `Bearer ${secret}x`, `Bearer ${"b".repeat(64)}`]) assert.equal(validCronAuthorization(header, secret), false);
  assert.equal(validCronAuthorization("Bearer short", "short"), false);
});
test("monitor alerts on missing backup and database outage, healthy check is silent", async () => {
  const alerts: string[] = [];
  const alert = async (message: string) => { alerts.push(message); };
  assert.deepEqual(await inspectBackup({ read: async () => ({ backup_id: id, last_verified_at: new Date(now) }), alert, now }), { healthy: true, alerted: false });
  assert.equal(alerts.length, 0);
  assert.deepEqual(await inspectBackup({ read: async () => undefined, alert, now }), { healthy: false, alerted: true });
  assert.deepEqual(await inspectBackup({ read: async () => { throw new Error("database unavailable"); }, alert, now }), { healthy: false, alerted: true });
  assert.equal(alerts.length, 2);
  await assert.rejects(inspectBackup({ read: async () => undefined, alert: async () => { throw new Error("smtp unavailable"); }, now }));
});
