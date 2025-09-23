export const dynamic = "force-dynamic";

// Minimal inline embeddings caller (no imports)
async function embedTexts(texts: string[], model = "text-embedding-3-small"): Promise<number[][]> {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is missing");
  }
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model, input: texts }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`OpenAI embeddings error ${res.status}: ${errText}`);
  }
  const json = await res.json();
  return (json?.data ?? []).map((d: any) => d.embedding as number[]);
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const text = (url.searchParams.get("text") || "").trim() || "hello world";
  try {
    const [vec] = await embedTexts([text]);
    return new Response(
      JSON.stringify({ ok: true, model: "text-embedding-3-small", dims: Array.isArray(vec) ? vec.length : 0 }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, error: e?.message || String(e) }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
}