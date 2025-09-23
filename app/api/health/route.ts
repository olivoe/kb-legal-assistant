export const dynamic = "force-dynamic";

export async function GET() {
  const required = ["OPENAI_API_KEY", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"] as const;
  const missing = required.filter((k) => !process.env[k] || String(process.env[k]).trim() === "");
  return new Response(
    JSON.stringify({ ok: true, envOk: missing.length === 0, missing }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}
