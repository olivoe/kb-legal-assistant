// src/app/api/chat/route.ts
import type { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

// GET /api/chat — health check
export async function GET(_req: NextRequest) {
  return new Response("chat route alive", {
    status: 200,
    headers: { "content-type": "text/plain" },
  });
}

// POST /api/chat — minimal echo
export async function POST(req: NextRequest) {
  let body: any = {};
  try { body = await req.json(); } catch {}
  return new Response(
    JSON.stringify({ ok: true, from: "minimal", echo: body?.message ?? null }),
    { headers: { "content-type": "application/json" } }
  );
}