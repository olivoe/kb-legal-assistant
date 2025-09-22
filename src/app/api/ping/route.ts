export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return new Response("pong", {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
