import { createContent } from "@/lib/content";
export const runtime = "nodejs";
export async function POST(request: Request) { return createContent(request); }
