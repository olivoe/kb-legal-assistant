/* Minimal OpenAI embeddings utilities */
import OpenAI from "openai";

export type EmbeddingVector = number[];

const EMBEDDING_MODEL =
  process.env.EMBEDDING_MODEL || "text-embedding-3-small";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

/** Light cleanup + defensive truncation for embedding inputs */
function prep(text: string): string {
  // keep it simple: collapse whitespace and trim
  const cleaned = (text ?? "").toString().replace(/\s+/g, " ").trim();
  // embeddings can handle long inputs, but don’t send megabytes
  // truncate by characters as a cheap guard (tune if you like)
  return cleaned.slice(0, 8000);
}

/** Compute one embedding vector */
export async function embedText(text: string): Promise<EmbeddingVector> {
  const input = prep(text);
  const res = await client.embeddings.create({
    model: EMBEDDING_MODEL,
    input,
  });
  const vec = res.data[0]?.embedding as number[] | undefined;
  if (!vec) throw new Error("Failed to obtain embedding");
  return vec;
}

/** Batch embeddings, chunking large arrays to avoid payload limits */
export async function embedMany(
  texts: string[],
  chunkSize = 128
): Promise<EmbeddingVector[]> {
  const out: EmbeddingVector[] = [];
  for (let i = 0; i < texts.length; i += chunkSize) {
    const slice = texts.slice(i, i + chunkSize).map(prep);
    const res = await client.embeddings.create({
      model: EMBEDDING_MODEL,
      input: slice,
    });
    for (const row of res.data) {
      out.push(row.embedding as number[]);
    }
  }
  return out;
}

/** L2 norm */
export function norm(v: EmbeddingVector): number {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  return Math.sqrt(s);
}

/** Dot product */
export function dot(a: EmbeddingVector, b: EmbeddingVector): number {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i] * (b[i] ?? 0);
  return s;
}

/** Cosine similarity in [-1, 1] */
export function cosineSim(a: EmbeddingVector, b: EmbeddingVector): number {
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return 0;
  return dot(a, b) / (na * nb);
}

/** Optional helper to normalize a vector to unit length */
export function normalize(v: EmbeddingVector): EmbeddingVector {
  const n = norm(v);
  if (!n) return v.slice();
  return v.map((x) => x / n);
}