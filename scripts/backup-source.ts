import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { checkedPath, fail, projectRoot } from "./backup-config";

const rootFiles = ["package.json", "package-lock.json", "tsconfig.json", "next.config.ts", "next-env.d.ts", "eslint.config.mjs", "postcss.config.mjs", "vercel.json"];
const directories = new Map([["src", /\.(ts|tsx|css)$/], ["scripts", /\.ts$/], ["migrations", /\.sql$/], ["tests", /\.ts$/]]);
export function allowedSourceFile(relative: string) {
  if (relative === ".github/workflows/backup.yml") return true;
  if (relative.includes("\\") || relative.split("/").some(part => part.startsWith(".") || /(?:secret|credential|backup|recovery-ledger|\.env)/i.test(part) && !/^backup(?:[-.].*)?\.ts$/.test(part))) return false;
  if (rootFiles.includes(relative)) return true;
  const [dir, ...parts] = relative.split("/");
  return parts.length > 0 && !!directories.get(dir)?.test(relative);
}

export async function sourceSnapshot() {
  const files: string[] = [];
  async function visit(relative: string) {
    const absolute = path.join(projectRoot, relative);
    await checkedPath(absolute);
    const stat = await lstat(absolute);
    if (stat.isDirectory()) {
      for (const child of await readdir(absolute)) await visit(`${relative}/${child}`);
    } else if (allowedSourceFile(relative)) files.push(relative);
  }
  for (const dir of directories.keys()) await visit(dir);
  await visit(".github/workflows/backup.yml").catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
  for (const file of rootFiles) {
    try { await lstat(path.join(projectRoot, file)); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    files.push(file);
  }
  const records = [];
  let totalBytes = 0;
  for (const file of files.sort()) {
    await checkedPath(path.join(projectRoot, file));
    const handle = await open(path.join(projectRoot, file), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 5 * 1024 * 1024) throw fail();
      const data = await handle.readFile();
      totalBytes += data.length;
      if (totalBytes > 30 * 1024 * 1024) throw fail();
      records.push({ path: file, sha256: createHash("sha256").update(data).digest("hex"), base64: data.toString("base64") });
    } finally { await handle.close(); }
  }
  return Buffer.from(JSON.stringify({ format: 1, kind: "source-files", files: records }));
}
