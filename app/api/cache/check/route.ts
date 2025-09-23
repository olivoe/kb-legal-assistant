export const dynamic = "force-dynamic";

// Minimal Upstash REST client (no deps)
async function upstash(cmd: string[], url?: string, token?: string) {
  if (!url || !token) return { ok: false, error: "redis-not-configured" as const };
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(cmd),
    // next: { revalidate: 0 } // not needed; dynamic route
  });
  if (!r.ok) return { ok: false, error: `http-${r.status}` as const };
  return r.json();
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const key = searchParams.get("key") || "";

  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.REDIS_REST_TOKEN;

  if (!key) {
    return new Response(JSON.stringify({ ok: true, note: "pass ?key=your-key to inspect", configured: !!(url && token) }), {
      status: 200, headers: { "Content-Type": "application/json" }
    });
  }

  const get = await upstash(["GET", key], url, token);
  const ttl = await upstash(["PTTL", key], url, token);
  const type = await upstash(["TYPE", key], url, token);

  return new Response(JSON.stringify({
    ok: true,
    key,
    present: !!(get && (get.result ?? get.value) !== null),
    valuePreview: typeof get?.result === "string" ? get.result.slice(0, 160) : get?.result ?? null,
    type: type?.result ?? null,
    pttl_ms: typeof ttl?.result === "number" ? ttl.result : null,
    configured: !!(url && token),
    errors: [get?.error, ttl?.error, type?.error].filter(Boolean)
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}
