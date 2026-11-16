import { changeContent } from "@/lib/content";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };
export async function PATCH(request: Request, context: Context) { return changeContent(request, (await context.params).id, "post"); }
export async function DELETE(request: Request, context: Context) { return changeContent(request, (await context.params).id, "post"); }
