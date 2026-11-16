import { z } from "zod";
import { idSchema } from "./security";
import { ApiError } from "./errors";

const cursorSchema = z.object({ at: z.string().datetime(), id: idSchema }).strict();
export function readCursor(request: Request) {
  const raw = new URL(request.url).searchParams.get("cursor");
  if (!raw) return null;
  try {
    if (raw.length > 300 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw new Error();
    return cursorSchema.parse(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
  } catch { throw new ApiError(400, "Ungültige Seitenauswahl."); }
}
export function cursorFor(row: { id: string; cursorAt: string }) {
  return Buffer.from(JSON.stringify({ at: row.cursorAt, id: row.id })).toString("base64url");
}
