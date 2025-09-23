import { requireEnv } from "@/app/lib/env";

export const dynamic = "force-dynamic";

export async function GET() {
  let envOk = true, envError: string | null = null;
  try {
    requireEnv(["OPENAI_API_KEY", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]);
  } catch (e: any) {
    envOk = false;
    envError = e?.message ?? String(e);
  }
  return new Response(JSON.stringify({ ok: true, envOk, envError, service: "kb-legal-assistant" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
