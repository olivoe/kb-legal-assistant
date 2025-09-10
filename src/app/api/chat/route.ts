/* eslint-disable no-restricted-syntax */
export const runtime = "nodejs";

import { NextRequest } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import OpenAI from "openai";

/* ===========================
   Types (no `any`)
=========================== */

type Doc = { filename: string; text: string };

type Hit = { filename: string; snippet: string };

// Minimal shape returned by vectorStores.search(...)
type VSResult = {
  filename?: string;
  content?: Array<{ text?: string }>;
  score?: number;
};

// Minimal shape returned by vectorStores.files.list(...).data[i]
type VSFileItem = {
  id: string; // vector-store file record id
  file_id?: string; // actual file id to use with files.* endpoints
};

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || "" });
const STORE_ID = process.env.OPENAI_VECTOR_STORE_ID || "";
const KB_MODE = (process.env.KB_MODE || "local").toLowerCase(); // "local" | "openai"

/* ===========================
   Helpers
=========================== */

function normalize(s: string): string {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");
}

async function loadLocalKB(dir = "kb"): Promise<Doc[]> {
  const base = path.resolve(dir);
  let entries: string[] = [];
  try {
    entries = await fs.readdir(base);
  } catch {
    return [];
  }

  const files = entries
    .filter((f) => /\.(txt|md)$/i.test(f))
    .map((f) => path.join(base, f));

  const docs: Doc[] = [];
  for (const f of files) {
    try {
      const text = await fs.readFile(f, "utf8");
      docs.push({ filename: path.basename(f), text });
    } catch {
      // ignore unreadable files
    }
  }
  return docs;
}

function findMatches(q: string, docs: Doc[]): Hit[] {
  const qNorm = normalize(q).replace(/[“”"']/g, "");
  const numTokens = qNorm.match(/\b\d+\b/g) ?? [];
  const wordTokens = Array.from(new Set(qNorm.split(/[^a-z0-9áéíóúñü]+/i))).filter(
    (w) => w.length >= 5,
  );

  const phrases = [
    "articulo 123 del codigo procesal",
    "articulo 123 codigo procesal",
    "123 del codigo procesal",
  ];

  const hits: Hit[] = [];

  for (const { filename, text } of docs) {
    const textNorm = normalize(text);

    let matched = phrases.some((p) => textNorm.includes(p));
    if (!matched) {
      const wordHits = wordTokens.filter((w) => textNorm.includes(w));
      const numHits = numTokens.filter((n) => textNorm.includes(n));
      matched = numHits.length >= 1 || wordHits.length >= 2;
    }

    if (matched) {
      const anchor =
        numTokens.find((n) => textNorm.includes(n)) ??
        wordTokens.find((w) => textNorm.includes(w)) ??
        phrases.find((p) => textNorm.includes(p)) ??
        "";
      const idx = anchor ? textNorm.indexOf(anchor) : 0;
      const start = Math.max(0, idx - 160);
      const end = Math.min(text.length, idx + (anchor?.length || 0) + 160);
      const snippet = text.slice(start, end).replace(/\s+/g, " ");
      hits.push({ filename, snippet });
    }
  }

  return hits;
}

/* ===========================
   Route Handler
=========================== */

export async function POST(req: NextRequest) {
  try {
    // Parse body strictly without `any`
    const body = (await req.json()) as unknown;
    const message =
      typeof body === "object" && body !== null && "message" in (body as Record<string, unknown>)
        ? (body as Record<string, unknown>).message
        : undefined;

    const q = typeof message === "string" ? message.trim() : "";
    if (!q) {
      return Response.json({ answer: "No hay información suficiente en la base.", citations: [] });
    }

    let docs: Doc[] = [];

    if (KB_MODE === "openai") {
      // 1) Try OpenAI vector search first
      if (!process.env.OPENAI_API_KEY || !STORE_ID) {
        return Response.json({ answer: "No hay información suficiente en la base.", citations: [] });
      }

      let results: VSResult[] = [];
      try {
        // Return type is not fully typed by SDK → treat as unknown then narrow
        const resUnknown = await client.vectorStores.search(STORE_ID, { query: q });
        const narrowed = (resUnknown as unknown) as { data?: VSResult[] };
        results = Array.isArray(narrowed?.data) ? narrowed.data : [];
      } catch {
        results = [];
      }

      const fromSearch: Doc[] = results
        .map((r) => ({
          filename: r.filename ?? "desconocido",
          text: r.content?.[0]?.text ?? "",
        }))
        .filter((d) => d.text.length > 0);

      docs = fromSearch;

      // 2) Fallback: if search returned nothing, read the full files from the store and match locally
      if (!docs.length) {
        try {
          const listUnknown = await client.vectorStores.files.list(STORE_ID, { limit: 100 });
          const items = ((listUnknown as unknown) as { data?: VSFileItem[] }).data ?? [];

          for (const vf of items) {
            const fileId = vf.file_id ?? vf.id;
            try {
              const metaUnknown = await client.files.retrieve(fileId);
              const meta = metaUnknown as { filename?: string };
              const name = meta?.filename ?? fileId;

              const contentResp = await client.files.content(fileId);
              const text = (await contentResp.text()).slice(0, 1_500_000);
              if (text) docs.push({ filename: name, text });
            } catch {
              // skip unreadable/binary
            }
          }
        } catch {
          // ignore list errors; will return "no info" later if still empty
        }
      }
    } else {
      // DEV/local mode
      docs = await loadLocalKB("kb");
    }

    if (!docs.length) {
      return Response.json({ answer: "No hay información suficiente en la base.", citations: [] });
    }

    const hits = findMatches(q, docs);
    if (!hits.length) {
      return Response.json({ answer: "No hay información suficiente en la base.", citations: [] });
    }

    const top = hits.slice(0, 3);
    const citations = top.map((h) => h.filename);
    const answer = `Se encontró la información en: ${citations.join(
      ", ",
    )}. Ejemplo: ${top[0].snippet.slice(0, 220)}…`;

    return Response.json({ answer, citations });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // Log a compact error line; avoids eslint unused vars
    console.error("API error:", msg);
    return Response.json({ error: true, message: msg }, { status: 500 });
  }
}