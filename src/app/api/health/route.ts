export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return new Response("ok", { headers: { "content-type": "text/plain" } });
}