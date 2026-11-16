import { spawn } from "node:child_process";
import { checkedPath, fail, postgresEnvironment } from "./backup-config";
import path from "node:path";

export async function postgresBinary(bin: string, name: "pg_dump" | "pg_restore") {
  const executable = path.join(bin, name);
  await checkedPath(executable);
  const child = spawn(executable, ["--version"], { env: { NODE_ENV: "production", PATH: "/usr/bin:/bin", LANG: "C" }, stdio: ["ignore", "pipe", "ignore"] });
  let version = "";
  child.stdout.on("data", (chunk: Buffer) => { if (version.length < 256) version += chunk.toString("utf8"); });
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  try {
    await new Promise<void>((resolve, reject) => { child.once("error", () => reject(fail())); child.once("close", code => code === 0 ? resolve() : reject(fail())); });
    if (!new RegExp(`^${name} \\(PostgreSQL\\) 18(?:\\.|\\s)`).test(version)) throw fail();
    return executable;
  } finally { clearTimeout(timer); }
}

export function postgresProcess(executable: string, args: string[], url: URL, bin: string) {
  const child = spawn(executable, args, { env: postgresEnvironment(url, bin), stdio: ["ignore", "pipe", "ignore"] });
  const timer = setTimeout(() => child.kill("SIGKILL"), 15 * 60_000);
  const done = new Promise<void>((resolve, reject) => {
    child.once("error", () => reject(fail()));
    child.once("close", code => code === 0 ? resolve() : reject(fail()));
  }).finally(() => clearTimeout(timer));
  // Attach a handler immediately, including when the consumer is still opening a file.
  void done.catch(() => {});
  return { child, done };
}
