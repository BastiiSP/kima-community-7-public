import { ApiError } from "./errors";

export function chatPage(request: Request) {
  const params = new URL(request.url).searchParams;
  const before = params.get("before"), after = params.get("after");
  if ((before !== null && after !== null) || params.getAll("before").length > 1 || params.getAll("after").length > 1) {
    throw new ApiError(400, "Bitte nur eine Chat-Seite auswählen.");
  }
  const cursor = before ?? after;
  if (cursor !== null && (!/^(0|[1-9][0-9]{0,18})$/.test(cursor) || BigInt(cursor) > 9223372036854775807n)) {
    throw new ApiError(400, "Ungültige Chat-Seitenauswahl.");
  }
  return { before, after };
}
