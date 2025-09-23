type EmbeddingModel =
  | "text-embedding-3-small"
  | "text-embedding-3-large";

const DEFAULT_MODEL: EmbeddingModel = "text-embedding-3-small";

/** Call OpenAI Embeddings API for one or many texts. */
export async function embedTexts(
  texts: string[],
  model: EmbeddingModel = DEFAULT_MODEL
): Promise<number[][]> {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is missing");
  }
  // OpenAI embeddings require inputs <= ~8192 tokens; keep chunks reasonable upstream.
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model, input: texts }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`OpenAI embeddings error ${res.status}: ${errText}`);
  }
  const json = await res.json();
  // json.data[i].embedding -> number[]
  const out: number[][] = (json?.data ?? []).map((d: any) => d.embedding as number[]);
  return out;
}

/** Cosine similarity between two vectors (no allocations). */
export function cosineSim(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
