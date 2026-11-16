import { constants, createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, readdir, rename, rm, rmdir, unlink, lstat } from "node:fs/promises";
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { z } from "zod";
import { checkedPath, fail, privateDirectory, readPrivate } from "./backup-config";

const headerSchema = z.object({ format: z.literal(1), id: z.string().regex(/^(database|source|ledger)-\d{8}T\d{6}Z-[0-9a-f-]{36}$/), kind: z.enum(["database", "source", "ledger"]), startedAt: z.iso.datetime() }).strict();
export const manifestSchema = z.object({ header: headerSchema, iv: z.string().regex(/^[0-9a-f]{24}$/), tag: z.string().regex(/^[0-9a-f]{32}$/), sha256: z.string().regex(/^[0-9a-f]{64}$/), bytes: z.number().int().positive() }).strict();
export type Manifest = z.infer<typeof manifestSchema>;
export type Header = Manifest["header"];
export const bundlePattern = /^(database|source|ledger)-\d{8}T\d{6}Z-[0-9a-f-]{36}$/;

export function newHeader(kind: Header["kind"]): Header {
  const startedAt = new Date().toISOString();
  return { format: 1, kind, startedAt, id: `${kind}-${startedAt.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}-${randomUUID()}` };
}

export async function writePrivate(file: string, data: string | Buffer) {
  const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
}

export async function syncDirectory(dir: string) {
  const handle = await open(dir, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

export async function atomicJson(dir: string, filename: string, data: unknown) {
  const temp = path.join(dir, `.state-${randomUUID()}`);
  try {
    await writePrivate(temp, JSON.stringify(data) + "\n");
    await rename(temp, path.join(dir, filename));
    await syncDirectory(dir);
  } finally { await unlink(temp).catch(() => {}); }
}

export async function lockDirectory<T>(dir: string, run: () => Promise<T>) {
  const lock = path.join(dir, ".backup-lock");
  await mkdir(lock, { mode: 0o700 }); // A stale lock needs operator investigation; never steal it.
  try { return await run(); } finally { await rmdir(lock); }
}

export async function encryptStream(input: Readable, file: string, key: Buffer, header: Header): Promise<Manifest> {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(JSON.stringify([header.format, header.id, header.kind, header.startedAt])));
  const digest = createHash("sha256");
  let bytes = 0;
  const counter = new Transform({ transform(chunk: Buffer, _, callback) { digest.update(chunk); bytes += chunk.length; callback(null, chunk); } });
  await pipeline(input, cipher, counter, createWriteStream(file, { flags: "wx", mode: 0o600 }));
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
  return manifestSchema.parse({ header, iv: iv.toString("hex"), tag: cipher.getAuthTag().toString("hex"), sha256: digest.digest("hex"), bytes });
}

export async function readManifest(root: string, id: string) {
  if (!bundlePattern.test(id)) throw fail();
  const dir = path.join(root, id);
  await privateDirectory(dir);
  const manifest = manifestSchema.parse(JSON.parse((await readPrivate(path.join(dir, "manifest.json"))).toString("utf8")));
  if (manifest.header.id !== id || !id.startsWith(`${manifest.header.kind}-`)) throw fail();
  const entries = await readdir(dir);
  if (entries.length !== 2 || !entries.includes("manifest.json") || !entries.includes("payload.enc")) throw fail();
  return { dir, manifest };
}

/** Output may contain unauthenticated plaintext until final() succeeds: NEVER consume before return. */
export async function decryptBundle(root: string, id: string, key: Buffer, output?: string) {
  const { dir, manifest } = await readManifest(root, id);
  const file = path.join(dir, "payload.enc");
  await checkedPath(file, true);
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid?.() || stat.size !== manifest.bytes) throw fail();
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(manifest.iv, "hex"));
    decipher.setAAD(Buffer.from(JSON.stringify([manifest.header.format, manifest.header.id, manifest.header.kind, manifest.header.startedAt])));
    decipher.setAuthTag(Buffer.from(manifest.tag, "hex"));
    const digest = createHash("sha256");
    const counter = new Transform({ transform(chunk: Buffer, _, callback) { digest.update(chunk); callback(null, chunk); } });
    const sink = output ? createWriteStream(output, { flags: "wx", mode: 0o600 })
      : new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    await pipeline(createReadStream(file, { fd: handle.fd, autoClose: false }), counter, decipher, sink);
    if (digest.digest("hex") !== manifest.sha256) throw fail();
    return manifest;
  } catch {
    if (output) await unlink(output).catch(() => {});
    throw fail();
  } finally { await handle.close(); }
}

export async function publishBundle(root: string, header: Header, writer: (file: string) => Promise<Manifest>) {
  const pending = path.join(root, `.pending-${header.id}`);
  await mkdir(pending, { mode: 0o700 });
  try {
    const manifest = await writer(path.join(pending, "payload.enc"));
    await writePrivate(path.join(pending, "manifest.json"), JSON.stringify(manifest) + "\n");
    await syncDirectory(pending);
    await rename(pending, path.join(root, header.id));
    await syncDirectory(root);
    return manifest;
  } finally { await rm(pending, { recursive: true, force: true }); }
}

export async function bundleIds(root: string) {
  const entries = await readdir(root);
  return entries.filter(name => bundlePattern.test(name)).sort();
}

export function stale(manifest: Manifest, now = Date.now()) {
  const age = now - Date.parse(manifest.header.startedAt);
  return age < -60_000 || age > 26 * 60 * 60 * 1000;
}

export async function retainBundles(root: string, key: Buffer, days: 7) {
  // Authenticate ALL bundles before deletion. Unknown files and partial runs are never removed.
  const manifests = [];
  for (const id of await bundleIds(root)) manifests.push(await decryptBundle(root, id, key));
  for (const manifest of manifests) {
    if (Date.now() - Date.parse(manifest.header.startedAt) <= days * 86400_000) continue;
    const dir = path.join(root, manifest.header.id);
    await privateDirectory(dir);
    // Refuse unexpected files or symlinks even after authentication.
    for (const name of await readdir(dir)) {
      if (!["manifest.json", "payload.enc"].includes(name) || !(await lstat(path.join(dir, name))).isFile()) throw fail();
    }
    await unlink(path.join(dir, "payload.enc"));
    await unlink(path.join(dir, "manifest.json"));
    await rmdir(dir);
  }
  await syncDirectory(root);
}
