/**
 * RAG retrieval: loads ./data/kb_index.json, embeds the query,
 * and returns top-K chunks by cosine similarity.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { EmbeddingVector } from "./embeddings";
import { embedText, norm } from "./embeddings";

type KBChunk = {
  id: string;
  file: string;
  chunk: number;
  start: number;
  end: number;
  text: string;
  embedding: number[];
};

type KBIndex = {
  meta: {
    kbDir: string;
    builtAt: string;
    embeddingModel: string;
    chunkChars: number;
    chunkOverlap: number;
    filesDigest: string;
    fileCount: number;
    chunkCount: number;
  };
  chunks: KBChunk[];
};

type LoadedChunk = KBChunk & { _norm: number };

let _cache:
  | {
      indexPath: string;
      mtimeMs: number;
      chunks: LoadedChunk[];
    }
  | null = null;

function indexPath(): string {
  return path.resolve(process.cwd(), "data", "kb_index.json");
}

async function fileMtimeMs(p: string): Promise<number> {
  const st = await fsp.stat(p);
  return st.mtimeMs;
}

/** Lazily load + memoize the index; auto-reload if file changes */
async function loadIndex(): Promise<LoadedChunk[]> {
  const p = indexPath();
  if (!fs.existsSync(p)) return [];

  const mtimeMs = await fileMtimeMs(p);
  if (_cache && _cache.indexPath === p && _cache.mtimeMs === mtimeMs) {
    return _cache.chunks;
  }

  const raw = await fsp.readFile(p, "utf8");
  const parsed = JSON.parse(raw) as KBIndex;

  const chunks: LoadedChunk[] = (parsed?.chunks ?? []).map((c) => ({
    ...c,
    _norm: norm(c.embedding as EmbeddingVector),
  }));

  _cache = { indexPath: p, mtimeMs, chunks };
  return chunks;
}

function dot(a: EmbeddingVector, b: EmbeddingVector): number {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += (a[i] ?? 0) * (b[i] ?? 0);
  return s;
}

/**
 * Retrieve top-K matching chunks for a query.
 * Returns: [{ id, file, start, end, text, score }]
 */
export async function ragSearch(query: string, topK = 5): Promise<
  Array<{ id: string; file: string; start: number; end: number; text: string; score: number }>
> {
  const chunks = await loadIndex();
  if (!chunks.length) return [];

  const qVec = (await embedText(query)) as EmbeddingVector;
  const qNorm = norm(qVec);
  if (!qNorm) return [];

  const scored = chunks.map((c) => {
    const s = c._norm ? dot(qVec, c.embedding) / (qNorm * c._norm) : 0;
    return { id: c.id, file: c.file, start: c.start, end: c.end, text: c.text, score: s };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.max(1, topK));
}