// app/api/rag/stream/route.ts
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const revalidate = 0;

// --- Deterministic SSE test mode (?test=1) ---
async function sseTestResponse() {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(`event: init\ndata: {"ok":true}\n\n`));
      const tokens = ["Hola", " ", "mundo", "."];
      let i = 0;
      const id = setInterval(() => {
        if (i >= tokens.length) {
          clearInterval(id);
          controller.enqueue(encoder.encode(`event: done\ndata: {}\n\n`));
          controller.close();
          return;
        }
        controller.enqueue(
          encoder.encode(
            `event: response.output_text.delta\ndata: {"delta":"${tokens[i++]}" }\n\n`
          )
        );
      }, 120);
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  if (url.searchParams.get("test") === "1") {
    // quick ping to confirm we’re on the right route (no SSE for GET)
    return new Response(JSON.stringify({ ok: true, route: "/api/rag/stream", mode: "test" }), {
      headers: { "Content-Type": "application/json" },
    });
  }
  return new Response(JSON.stringify({ ok: false, error: "Use POST ?test=1" }), {
    status: 405,
    headers: { "Content-Type": "application/json" },
  });
}

export async function POST(req: Request) {
  const url = new URL(req.url);
  if (url.searchParams.get("test") === "1") {
    return sseTestResponse();
  }
  // Not implemented for non-test requests
  return new Response(JSON.stringify({ ok: false, error: "Use ?test=1 for deterministic stream" }), {
    status: 501,
    headers: { "Content-Type": "application/json" },
  });
}