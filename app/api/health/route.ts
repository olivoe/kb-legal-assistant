// app/api/health/route.ts
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const revalidate = 0;

import { NextResponse } from "next/server";

export async function GET() {
  const required = ["OPENAI_API_KEY", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"] as const;
  const missing = required.filter((k) => !process.env[k] || String(process.env[k]).trim() === "");
  return NextResponse.json({
    ok: true,
    service: "kb-legal-assistant",
    version: process.env.APP_VERSION ?? "v1",
    runtime: "node",
    time: new Date().toISOString(),
    envOk: missing.length === 0,
    missing,
  });
}