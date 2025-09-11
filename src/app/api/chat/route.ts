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
type Turn = { role: "user" | "assistant"; content: string };

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

  // Extend with Spain immigration domain phrases as needed
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

/* ----- Display name mapping (labels + prettifier) ----- */

let LABELS_CACHE: Record<string, string> | null = null;

async function loadLabels(): Promise<Record<string, string>> {
  if (LABELS_CACHE) return LABELS_CACHE;
  try {
    // Optional file: kb/labels.json
    const p = path.resolve("kb", "labels.json");
    const txt = await fs.readFile(p, "utf8");
    LABELS_CACHE = JSON.parse(txt) as Record<string, string>;
  } catch {
    LABELS_CACHE = {};
  }
  return LABELS_CACHE!;
}

function baseNameNoExt(filename: string): string {
  const base = path.basename(filename);
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(0, i) : base;
}

function titleCase(s: string): string {
  return s
    .split(/\s+/)
    .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(" ");
}

function prettifyName(filename: string): string {
  const base = baseNameNoExt(filename)
    .replace(/[_\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return titleCase(base || filename);
}

async function displayNameFor(filename: string): Promise<string> {
  const labels = await loadLabels();
  const base = baseNameNoExt(filename);
  // Prefer exact filename match, then base name, else prettify
  return labels[filename] || labels[base] || prettifyName(filename);
}

/* ----- Deterministic fallback helpers (11A-fix) ----- */

function hasStrongEvidence(snips: Hit[]): boolean {
  const NEEDLES = [
    "artículo",
    "articulo",
    "formulario",
    "modelo",
    "plazo",
    "plazos",
    "requisito",
    "requisitos",
    "notificación",
    "notificaciones",
    "procedimiento",
    "trámite",
    "tramite",
    "código",
    "codigo",
    "ley",
  ];
  return snips.some((h) => {
    const t = h.snippet.toLowerCase();
    return t.length > 80 && NEEDLES.some((w) => t.includes(w));
  });
}

function deterministicFromSnippets(_q: string, snips: Hit[]): string {
  // naive sentence splitter
  const SENT_SPLIT = /(?<=\.|\?|¡|!|;)\s+/g;
  const KEY = [
    "artículo",
    "articulo",
    "plazo",
    "plazos",
    "notificación",
    "notificaciones",
    "formulario",
    "modelo",
    "requisito",
    "requisitos",
    "procedimiento",
    "trámite",
    "tramite",
    "código",
    "codigo",
    "ley",
  ];

  const chosen: string[] = [];
  for (const s of snips) {
    const sentences = s.snippet.replace(/\s+/g, " ").trim().split(SENT_SPLIT);
    const hit =
      sentences.find((x) => {
        const lx = x.toLowerCase();
        return KEY.some((k) => lx.includes(k));
      }) || sentences[0];
    if (hit) {
      chosen.push(hit.trim());
    }
    if (chosen.length >= 2) break;
  }

  const body = chosen.join(" ");
  // Jurist/formal and explicitly referential
  return body
    ? `${body} (respuesta referencial basada en los documentos citados).`
    : "No hay información suficiente en la base.";
}

/* ----- Model composition ----- */

/**
 * Compose a concise Spanish answer from retrieved snippets.
 * Uses conversation history for context.
 * Falls back to the default “no info” sentence if the model returns empty.
 */
async function composeAnswer(
  question: string,
  snippets: Hit[],
  history: Turn[]
): Promise<string> {
  const snippetText = snippets.map((h) => `• ${h.filename}: “${h.snippet}”`).join("\n");

  // Compact recent history (last 6 turns)
  const recent = history.slice(-6);
  const histText = recent
    .map((t) => (t.role === "user" ? `Usuario: ${t.content}` : `Asistente: ${t.content}`))
    .join("\n");

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
              "Eres un asistente legal en español (enfocado en inmigración en España). " +
              "Estilo jurista y formal, longitud media; usa viñetas y un breve resumen inicial cuando sea útil. " +
              "Responde EXCLUSIVAMENTE con base en los fragmentos proporcionados. " +
              "Si la evidencia es insuficiente, responde exactamente: \"No hay información suficiente en la base.\" " +
              "Deja claro que la respuesta es referencial (no asesoramiento legal).",
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text:
              (histText ? `Contexto de conversación:\n${histText}\n\n` : "") +
              `Pregunta actual: ${question}\n\n` +
              `Fragmentos recuperados (usa solo estos, sin inventar):\n${snippetText}\n\n` +
              "Devuelve únicamente el texto final de la respuesta.",
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

    // Parse optional history (compact recent turns, role-validated, length trimmed)
    const history: Turn[] =
      typeof body === "object" &&
      body !== null &&
      "history" in (body as Record<string, unknown>) &&
      Array.isArray((body as Record<string, unknown>).history)
        ? ((body as Record<string, unknown>).history as Turn[])
            .filter(
              (t) =>
                t &&
                (t.role === "user" || t.role === "assistant") &&
                typeof t.content === "string"
            )
            .map((t) => ({ role: t.role, content: t.content.slice(0, 2000) }))
            .slice(-8)
        : [];

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

    // Prepare display names
    const citationsRaw = top.map((h) => h.filename);
    const citations = await Promise.all(citationsRaw.map(displayNameFor));
    const displaySnippets = await Promise.all(
      top.map(async (h) => ({ filename: await displayNameFor(h.filename), snippet: h.snippet }))
    );

    // Let the model compose a concise answer from the retrieved snippets + history
    let answer: string;
    try {
      answer = await composeAnswer(q, displaySnippets, history);
    } catch {
      // Safe fallback if the model call fails
      answer = `Se encontró la información en: ${citations.join(
        ", ",
      )}. Ejemplo: ${displaySnippets[0].snippet.slice(0, 220)}…`;
    }

    // 11A-fix: if model responded with "No hay..." but we have strong evidence, synthesize deterministically
    if (answer.trim() === "No hay información suficiente en la base." && hasStrongEvidence(top)) {
      if (DEBUG) {
        console.log(JSON.stringify({ event: "deterministic_fallback", q, citations_raw: citationsRaw }));
      }
      answer = deterministicFromSnippets(q, top);
    }

    // Include evidence snippets (with display names) in the response
    const evidence = displaySnippets;

    const runtimeMs = Date.now() - t0;
    if (DEBUG) {
      console.log(
        JSON.stringify({
          event: "chat_reply",
          mode: KB_MODE,
          q,
          citations_raw: citationsRaw,
          citations_display: citations,
          runtime_ms: runtimeMs,
          history_turns: history.length,
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