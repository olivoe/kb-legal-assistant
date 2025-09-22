/* eslint-disable @typescript-eslint/no-explicit-any */

import { NextRequest } from "next/server";
import OpenAI from "openai";
import fs from "node:fs";
import path from "node:path";
import he from "he";

/* ============================== CONFIG ============================== */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const CACHE_TTL_SECONDS = Number(process.env.CACHE_TTL_SECONDS || 120);
const KB_MODE = (process.env.KB_MODE || "local").toLowerCase() as "local" | "openai";
const LOCAL_KB_DIR = process.env.KB_DIR || "./data/kb";
const MAX_HITS = 3;

/* ============================ OPTIONAL REDIS ============================ */

let redis:
  | {
      get: (k: string) => Promise<any>;
      set: (k: string, v: string, opts?: { ex?: number }) => Promise<any>;
      del: (k: string) => Promise<any>;
    }
  | null = null;

(function initRedis() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Redis } = require("@upstash/redis");
    redis = new Redis({ url, token });
  }
})();

/* ============================== OPENAI ============================== */

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

/* ============================== TYPES/UTILS ============================== */

type Hit = { filename: string; snippet: string };

function safeParse<T = any>(s: unknown): T | null {
  if (typeof s !== "string") return s as T | null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

function slug(s: string) {
  return s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().trim();
}

function makeCacheKey(q: string, mode: "local" | "openai", filesKey: string | null) {
  return `v1::${mode}::${slug(q)}::${filesKey ?? "none"}`;
}

/**
 * Build forgiving query terms from the user question.
 * - Keeps the full normalized phrase
 * - Drops common Spanish stopwords to build a “strong” phrase
 * - Adds each strong token as a fallback
 */
function buildQueryTerms(q: string): string[] {
  const base = slug(q).replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
  const tokens = base.split(/\s+/).filter(Boolean);

  const stop = new Set([
    "el", "la", "los", "las", "de", "del", "y", "o", "en", "para", "por", "con",
    "un", "una", "unos", "unas", "al", "lo", "que", "se", "su", "sus", "a", "e",
    "es", "son", "este", "esta", "estos", "estas", "donde", "cuando", "como"
  ]);

  const strong = tokens.filter((t) => !stop.has(t));

  const out = new Set<string>();
  if (base) out.add(base);
  if (strong.length >= 2) out.add(strong.join(" "));
  strong.forEach((t) => out.add(t));

  return Array.from(out);
}

/* ==================== LOCAL KB: FILE READ & SEARCH ===================== */

// Basic HTML → text
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// PDF (no worker) text extract via pdfjs-dist
async function extractPdfTextFromBuffer(buf: Uint8Array): Promise<string> {
  const pdfjs: any = await import("pdfjs-dist/legacy/build/pdf.mjs");
  if (pdfjs.GlobalWorkerOptions) {
    pdfjs.GlobalWorkerOptions.workerSrc = undefined as any;
  }
  const task = pdfjs.getDocument({ data: buf });
  const pdf = await task.promise;

  let out = "";
  const maxPages = Math.min(pdf.numPages, 30);
  for (let i = 1; i <= maxPages; i++) {
    const p = await pdf.getPage(i);
    const tc = await p.getTextContent();
    out += tc.items.map((it: any) => it.str ?? "").join(" ") + "\n";
  }
  return out.trim();
}

/** Read a local file and return plain text regardless of extension */
async function readLocalFileAsText(fullPath: string): Promise<string | null> {
  try {
    const ext = path.extname(fullPath).toLowerCase();
    const buf = await fs.promises.readFile(fullPath);

    if (ext === ".pdf") {
      return await extractPdfTextFromBuffer(new Uint8Array(buf));
    }
    if (ext === ".html" || ext === ".htm") {
      // Decode entities after stripping tags
      const stripped = htmlToText(buf.toString("utf8"));
      return he.decode(stripped);
    }
    if (ext === ".docx") {
      try {
        const mod = await import("mammoth"); // optional; if not installed, fall through
        const mammoth = (mod as any).default || (mod as any);
        const result = await mammoth.extractRawText({ buffer: buf });
        const txt: string = result?.value || "";
        return txt || null;
      } catch {
        // If mammoth isn't available, fallback to binary->utf8 (may be noisy)
        return buf.toString("utf8");
      }
    }

    // Plain text-like (txt/md/markdown and others)
    return buf.toString("utf8");
  } catch {
    return null;
  }
}

function fileListForKey(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && /\.(txt|md|markdown|pdf|docx|html?|htm)$/i.test(e.name))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * New localSearch:
 * - Builds multiple query terms (phrase, strong-phrase, tokens)
 * - Matches against normalized document text
 * - Returns first meaningful snippet per file, up to topN files
 */
async function localSearch(question: string, topN = MAX_HITS): Promise<Hit[]> {
  const dir = LOCAL_KB_DIR;
  const hits: Hit[] = [];

  // Build forgiving terms once
  const terms = buildQueryTerms(question);
  if (terms.length === 0) return [];

  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const e of entries) {
    if (!e.isFile()) continue;
    if (!/\.(txt|md|markdown|pdf|docx|html?|htm)$/i.test(e.name)) continue;

    const full = path.join(dir, e.name);
    const text = await readLocalFileAsText(full);
    if (!text) continue;

    const plain = text.replace(/\s+/g, " ").trim();
    const norm = slug(plain).replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();

    // Try each term in order; first hit wins for this file
    let matchIdx = -1;
    for (const t of terms) {
      const idx = norm.indexOf(t);
      if (idx >= 0) {
        matchIdx = idx;
        break;
      }
    }
    if (matchIdx >= 0) {
      const start = Math.max(0, matchIdx - 120);
      const end = Math.min(plain.length, matchIdx + 120);
      const snippet = plain.substring(start, end);
      hits.push({ filename: e.name, snippet });
      if (hits.length >= topN) break;
    }
  }

  return hits;
}

/* =================== OPTIONAL LLM (compose if needed) =================== */

async function composeAnswer(question: string, snippets: Hit[]): Promise<string> {
  const snippetText = snippets.map((h) => `• ${h.filename}: “${h.snippet}”`).join("\n");

  const resp = await client.responses.create({
    model: MODEL,
    temperature: 0,
    input: [
      {
        role: "system",
        content: [
          {
            type: "text",
            text:
              "Eres un asistente legal en español (inmigración en España). " +
              "Estilo jurista y formal; longitud media; usa viñetas y breve resumen inicial. " +
              "Responde SOLO con base en los fragmentos proporcionados. " +
              "Si la evidencia es insuficiente, responde exactamente: \"No hay información suficiente en la base.\" " +
              "La respuesta es referencial (no constituye asesoramiento legal).",
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              `Pregunta: ${question}\n\n` +
              `Fragmentos recuperados (usa solo estos, sin inventar):\n${snippetText}\n\n` +
              "Devuelve únicamente el texto final de la respuesta.",
          },
        ],
      },
    ],
  });

  const anyResp = resp as any;
  const direct = anyResp?.output_text || anyResp?.response?.output_text;
  if (typeof direct === "string" && direct.trim()) return direct.trim();

  return "No hay información suficiente en la base.";
}

/* ================================ HANDLER ================================ */

export async function POST(req: NextRequest) {
  const t0 = Date.now();
  const url = new URL(req.url);
  const wantStream = url.searchParams.get("stream") === "1";
  const noCache = url.searchParams.get("nocache") === "1";

  let body: any = {};
try {
  body = await req.json();
} catch {}

// Fallback: allow message from query string for SSE GET-style tests
const urlObj = new URL(req.url);
const queryMsg = urlObj.searchParams.get("message");
const q: string = (
  (body?.message || queryMsg || "")
).toString().trim();
  const history: { role: "user" | "assistant"; content: string }[] = Array.isArray(body?.history) ? body.history : [];

  // --- KB search (local or openai tag) ---
  let hits: Hit[] = [];
  let filesKey: string | null = null;

  if (KB_MODE === "local") {
    const fileNamesForKey = fileListForKey(LOCAL_KB_DIR);
    filesKey = fileNamesForKey.length ? fileNamesForKey.join("|") : null;
    hits = q ? await localSearch(q, MAX_HITS) : [];
  } else {
    // Placeholder for OpenAI KB mode; we still include a filesKey for cache shaping
    hits = [];
    filesKey = "openai-files";
  }

  const displayCitations = Array.from(new Set(hits.map((h) => h.filename)));
  const cacheKey = makeCacheKey(q, KB_MODE, displayCitations.length ? displayCitations.join("|") : filesKey);

  /* ----------------------------- CACHE READ ----------------------------- */
  if (redis && !noCache) {
    try {
      const cachedRaw = await redis.get(cacheKey);
      if (cachedRaw) {
        const cachedObj = safeParse<any>(cachedRaw);
        const bodyUnwrapped =
          (cachedObj && typeof cachedObj === "object" && "answer" in cachedObj)
            ? cachedObj
            : (cachedObj && typeof cachedObj === "object" && "value" in cachedObj)
              ? safeParse<any>(cachedObj.value)
              : safeParse<any>(cachedRaw);

        if (bodyUnwrapped && typeof bodyUnwrapped === "object" && "answer" in bodyUnwrapped) {
          return Response.json(bodyUnwrapped, {
            headers: {
              "x-cache": "HIT",
              "x-cache-key": cacheKey,
              "x-cache-shared": "true",
              "x-cache-store": "redis",
              "x-runtime-ms": String(Date.now() - t0),
            },
          });
        }
        try { await redis.del(cacheKey); } catch {}
      }
    } catch {}
  }

// ---------- Streaming branch (SSE) ----------
if (wantStream) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      function send(line: string) {
        controller.enqueue(encoder.encode(line + "\n\n"));
      }

      try {
        // Always send an init event first so curl shows something immediately
        send(`event: init\ndata: ${JSON.stringify({ ok: true })}`);

        // Try OpenAI streaming first
        try {
          const oaStream = await client.responses.stream({
            model: MODEL,
            temperature: 0,
            input: [
              {
                role: "system",
                content: [
                  {
                    type: "input_text",
                    text:
                      "Eres un asistente legal en español (inmigración en España). " +
                      "Estilo jurista y formal; longitud media; usa viñetas y breve resumen inicial. " +
                      "Responde SOLO con base en los fragmentos proporcionados. " +
                      "Si la evidencia es insuficiente, responde exactamente: \"No hay información suficiente en la base.\" " +
                      "La respuesta es referencial (no constituye asesoramiento legal).",
                  },
                ],
              },
              {
                role: "user",
                content: [
                  {
                    type: "input_text",
                    text: `Pregunta: ${q}`,
                  },
                ],
              },
            ],
          });

          oaStream.on("response.output_text.delta", (evt: any) => {
            send(
              `event: response.output_text.delta\ndata: ${JSON.stringify({
                delta: evt.delta,
              })}`
            );
          });

          oaStream.on("response.completed", () => {
            send("data: [DONE]");
            controller.close();
          });

          oaStream.on("error", () => {
            send(
              `event: error\ndata: ${JSON.stringify({
                message: "openai-stream-error",
              })}`
            );
            send("data: [DONE]");
            controller.close();
          });

          await oaStream.start();
        } catch {
          // Fallback deterministic text if OpenAI streaming fails
          const text = "HELLO SSE TEST FROM SERVER SIDE";
          const CHUNK = 6;
          for (let i = 0; i < text.length; i += CHUNK) {
            send(
              `event: response.output_text.delta\ndata: ${JSON.stringify({
                delta: text.slice(i, i + CHUNK),
              })}`
            );
          }
          send("data: [DONE]");
          controller.close();
        }
      } catch {
        send(
          `event: error\ndata: ${JSON.stringify({ message: "start-failed" })}`
        );
        send("data: [DONE]");
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
/* ================== END STREAMING BRANCH (SSE) ================== */

  /* ========================== NON-STREAM JSON ========================== */
  try {
    // Deterministic answer when we have evidence (no LLM call)
    const json =
      hits.length > 0
        ? {
            answer:
              `Según la evidencia localizada en la base de conocimiento (referencial, no asesoramiento legal):\n\n` +
              hits.map((h) => `• ${h.filename}: “${h.snippet}”`).join("\n") +
              `\n\n*Nota: Respuesta referencial basada únicamente en los documentos citados.*`,
            citations: displayCitations,
            evidence: hits.map((h) => ({ filename: h.filename, snippet: h.snippet })),
          }
        : {
            answer: "No hay información suficiente en la base.",
            citations: [],
            evidence: [],
          };

    if (redis) {
      try {
        await redis.set(cacheKey, JSON.stringify(json), { ex: CACHE_TTL_SECONDS });
      } catch {}
    }

    return Response.json(json, {
      headers: {
        "x-cache": "MISS",
        "x-cache-key": cacheKey,
        "x-cache-shared": String(Boolean(redis)),
        "x-cache-store": redis ? "redis" : "none",
        "x-runtime-ms": String(Date.now() - t0),
      },
    });
  } catch (e: any) {
    console.error("API error:", e?.status || "", e?.message || e);
    return Response.json({ error: true, message: e?.message || "Unexpected error" }, { status: 500 });
  }
}