export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: { all?: string[] } };

export async function GET(_req: Request, ctx: Ctx) {
  const path = "/" + (ctx.params.all ?? []).join("/");
  return Response.json({ ok: true, method: "GET", path });
}

export async function POST(req: Request, ctx: Ctx) {
  const path = "/" + (ctx.params.all ?? []).join("/");
  let body: any = null;
  try { body = await req.json(); } catch {}
  return Response.json({ ok: true, method: "POST", path, body });
}