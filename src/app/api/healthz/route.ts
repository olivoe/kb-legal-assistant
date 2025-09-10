export const runtime = "nodejs";

import { NextRequest } from "next/server";

export async function GET(_req: NextRequest) {
  return Response.json({
    ok: true,
    mode: (process.env.KB_MODE || "local").toLowerCase(), // "openai" | "local"
    ts: new Date().toISOString(),
    uptime_s: Math.round(process.uptime()),
  });
}