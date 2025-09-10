/* eslint-disable no-restricted-syntax */
export const runtime = "nodejs";

import { NextRequest } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import OpenAI from "openai";

/* ===========================
   Basic per-IP rate limit
=========================== */

type Bucket = { count: number; resetAt: number };
type RateLimitResult = { ok: boolean; remaining: number; resetAt: number };

const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || 60); // default 60 req/min
const buckets = new Map<string, Bucket>();

function getClientIp(req: NextRequest): string {
  const xf = req.headers.get("x-forwarded-for") || "";
  const ip = xf.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "unknown";
  return ip;
}

function checkRateLimit(ip: string): RateLimitResult {
  const now = Date.now();
  const b = buckets.get(ip);
  if (!b || now >= b.resetAt) {
    const resetAt = now + RATE_LIMIT_WINDOW_MS;
    buckets.set(ip, { count: 1, resetAt });
    return { ok: true, remaining: RATE_LIMIT_MAX - 1, resetAt };
  }
  if (b.count >= RATE_LIMIT_MAX) {
    return { ok: false, remaining: 0, resetAt: b.resetAt };
  }
  b.count += 1;
  return { ok: true, remaining: RATE_LIMIT_MAX - b.count, resetAt: b.resetAt };
}

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
  id: string;       // vector-store file record id
  file_id?: string; // actual file id to use with files.* endpoints
};

// Minimal shape for Responses API readback we use
type ResponsesTextOnly = { output_text?: string };

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || "" });
const STORE_ID = process.env.OPENAI_VECTOR_STORE_ID || "";
// Use env override if present; otherwise OpenAI in prod, Local elsewhere
const KB_MODE = (
  process.env.KB_MODE ||
  (process.env.VERCEL_ENV === "production" ? "openai" : "local")
).toLowerCase(); // "local" | "openai"
const DEBUG = process.env.DEBUG_LOGS === "1";

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

/**
 * Compose a concise Spanish answer from retrieved snippets.
 * Falls back to the default “no info” sentence if the model returns empty.
 */
async function composeAnswer(question: string, snippets: Hit[]): Promise<string> {
  const snippetText = snippets.map((h) => `• ${h.filename}: “${h.snippet}”`).join("\n");

  const resp = await client.responses.create({
    model: "gpt-4o-mini",
    temperature: 0,
    input: [
      {
        role: "system",
        content: [
          {
            type: "input_text",
            text:
              "Eres un asistente legal en español. Responde de forma breve y clara " +
              "usando EXCLUSIVAMENTE los fragmentos proporcionados. Si no hay evidencia suficiente, " +
              'responde exactamente: "No hay información suficiente en la base."',
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text:
              `Pregunta: ${question}\n\n` +
              `Fragmentos recuperados (usa solo estos, sin inventar):\n${snippetText}\n\n` +
              "Devuelve solo el texto final de la respuesta.",
          },
        ],
      },
    ],
  });

  const out = (resp as unknown as ResponsesTextOnly).output_text?.trim() ?? "";
  return out.length > 0 ? out : "No hay información suficiente en la base.";
}

/* ===========================
   Route Handler
=========================== */

export async function POST(req: NextRequest) {
  // ---- Rate limit check (before any heavy work) ----
  const ip = getClientIp(req);
  const rl = checkRateLimit(ip);
  if (!rl.ok) {
    return new Response(
      JSON.stringify({ error: true, message: "Rate limit exceeded. Try again soon." }),
      {
        status: 429,
        headers: {
          "content-type": "application/json",
          "x-ratelimit-remaining": String(rl.remaining),
          "x-ratelimit-reset": String(rl.resetAt),
        },
      }
    );
  }

  const t0 = Date.now();

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
        // SDK returns { data: VSResult[] }
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

    // --- De-duplicate citations by filename (keep first / most relevant)
    const uniqueByFile = new Map<string, Hit>();
    for (const h of hits) {
      if (!uniqueByFile.has(h.filename)) uniqueByFile.set(h.filename, h);
    }
    const top = Array.from(uniqueByFile.values()).slice(0, 3);
    const citations = top.map((h) => h.filename);

    // Let the model compose a concise answer from the retrieved snippets
    let answer: string;
    try {
      answer = await composeAnswer(q, top);
    } catch {
      // Safe fallback if the model call fails
      answer = `Se encontró la información en: ${citations.join(
        ", ",
      )}. Ejemplo: ${top[0].snippet.slice(0, 220)}…`;
    }

    // Include evidence snippets in the response
    const evidence = top.map(({ filename, snippet }) => ({ filename, snippet }));

    const runtimeMs = Date.now() - t0;
    if (DEBUG) {
      console.log(
        JSON.stringify({
          event: "chat_reply",
          mode: KB_MODE,
          q,
          citations,
          runtime_ms: runtimeMs,
        })
      );
    }

    return Response.json(
      { answer, citations, evidence },
      {
        headers: {
          "x-ratelimit-remaining": String(rl.remaining),
          "x-ratelimit-reset": String(rl.resetAt),
          "x-runtime-ms": String(runtimeMs),
        },
      }
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("API error:", msg);
    return Response.json({ error: true, message: msg }, { status: 500 });
  }
}