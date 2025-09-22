// src/pages/api/chat.ts
import type { NextApiRequest, NextApiResponse } from "next";
import fs from "node:fs";
import path from "node:path";
import OpenAI from "openai";
import { ragSearch } from "@/lib/rag"; // embeddings first when KB_MODE=embed

const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

const KB_MODE = (process.env.KB_MODE || "embed").toLowerCase(); // "embed" | ...
const KB_DIR = process.env.KB_DIR || path.resolve(process.cwd(), "data", "kb");

type Hit = { filename: string; snippet: string; score?: number };

/* ----------------- utils ----------------- */
function* walk(dir: string): Generator<string> {
  const entries = fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : [];
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (/\.(txt|md|markdown)$/i.test(e.name)) yield p;
  }
}
function readText(fp: string): string {
  try { return fs.readFileSync(fp, "utf8"); } catch { return ""; }
}
function normalize(s: string) {
  return s
    .normalize("NFD").replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}
const STOP = new Set([
  "el","la","los","las","de","del","y","o","en","para","por","con",
  "un","una","unos","unas","al","lo","que","se","su","sus","a","e",
  "es","son","este","esta","estos","estas","donde","cuando","como",
  "qué","que","cuál","cual","cuáles","cuales"
]);
function tokensFromQuery(q: string): string[] {
  const toks = normalize(q).split(" ").filter(Boolean);
  const strong = toks.filter(t => t.length > 2 && !STOP.has(t));
  // uniques, preserve order
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of strong) if (!seen.has(t)) { seen.add(t); out.push(t); }
  return out;
}
function snippetAround(txt: string, idx: number, span = 140) {
  const start = Math.max(0, idx - span);
  const end = Math.min(txt.length, idx + span);
  return txt.slice(start, end).replace(/\s+/g, " ").trim();
}
function localKeywordSearch(q: string, maxHits: number): { hits: Hit[]; kwCount: number } {
  const toks = tokensFromQuery(q);
  const hits: Hit[] = [];
  if (!toks.length) return { hits, kwCount: 0 };

  for (const abs of walk(KB_DIR)) {
    const rel = path.relative(KB_DIR, abs);
    const raw = readText(abs);
    if (!raw) continue;

    const norm = normalize(raw);
    let score = 0;
    let bestIndex = Infinity;

    for (const t of toks) {
      const at = norm.indexOf(t);
      if (at >= 0) {
        score += 1;
        if (at < bestIndex) bestIndex = at;
      }
    }

    if (score > 0) {
      hits.push({ filename: rel, snippet: snippetAround(raw, bestIndex), score });
    }
  }

  hits.sort((a, b) => (b.score! - a.score!));
  return { hits: hits.slice(0, maxHits), kwCount: toks.length };
}
function trimSnippet(s: string, max = 420) {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : t.slice(0, max - 1) + "…";
}
function buildFragmentsForLLM(hits: Hit[]): string {
  return hits
    .map(h => `[${h.filename}${typeof h.score === "number" ? ` | score:${h.score}` : ""}]\n${trimSnippet(h.snippet)}`)
    .join("\n\n");
}

/* ----------------- handler ----------------- */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // GET: quick health
  if (req.method === "GET") {
    res.setHeader("content-type", "text/plain");
    return res.status(200).send("chat route alive (pages + sse + sources)");
  }

  // POST (stream)
  if (req.method === "POST" && req.query.stream === "1") {
    const body = (req.body ?? {}) as any;
    const message = String(body?.message ?? "").trim();

    const overfetch = Number(body?.opts?.overfetch ?? 9) || 9;
    const maxHits   = Number(body?.opts?.max_hits ?? 3) || 3;

    let embedTotal = 0;
    let hits: Hit[] = [];
    let kwTotal = 0;
    let mode = "embed-only";

    // 1) Try embeddings
    if (KB_MODE === "embed" && message) {
      try {
        const raw = await ragSearch(message, overfetch); // expected: { file, text, score }[]
        embedTotal = Array.isArray(raw) ? raw.length : 0;
        if (embedTotal > 0) {
          hits = raw.slice(0, maxHits).map((r: any) => ({
            filename: r.file, snippet: r.text, score: r.score,
          }));
        }
      } catch {
        // ignore, fall through to local
      }
    }

    // 2) Local keyword fallback if embeddings empty
    if (hits.length === 0 && message) {
      const out = localKeywordSearch(message, maxHits);
      hits = out.hits;
      kwTotal = out.kwCount;
      mode = "local-fallback";
    }

    // headers
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "x-cache": "MISS",
      "x-cache-store": "none",
      "x-rag-mode": mode,
      "x-rag-hybrid": "0",
      "x-rag-overfetch": String(overfetch),
      "x-rag-max-hits": String(maxHits),
      "x-rag-embed-total": String(embedTotal),
      "x-rag-embed-kept": String(Math.min(embedTotal, maxHits)),
      "x-rag-kw-total": String(kwTotal),
      "x-rag-hits": String(hits.length),
      "x-kb-dir": KB_DIR,
    });

    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
    };

    let closed = false;
    req.on("close", () => { closed = true; try { res.end(); } catch {} });

    // 1) init
    send("init", { ok: true });

    // 2) sources up-front
    const citations = Array.from(new Set(hits.map((h) => h.filename)));
    const evidence = hits.map((h) => ({ filename: h.filename, snippet: h.snippet, score: h.score }));
    send("sources", { citations, evidence });

    // 3) compose via LLM if we have fragments; otherwise fixed fallback
    if (hits.length === 0 || !process.env.OPENAI_API_KEY) {
      const answer = hits.length === 0
        ? "No hay información suficiente en la base."
        : `Según la evidencia localizada: ${citations.map(c => `[${c}]`).join(" ")}`;
      const CHUNK = 10;
      for (let i = 0; i < answer.length && !closed; i += CHUNK) {
        send("response.output_text.delta", { delta: answer.slice(i, i + CHUNK) });
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 6));
      }
      if (!closed) { res.write("data: [DONE]\n\n"); try { res.end(); } catch {} }
      return;
    }

    try {
      const fragmentsText = buildFragmentsForLLM(hits);

      const stream = await openai.responses.stream({
        model: MODEL,
        temperature: 0,
        input: [
          {
            role: "system",
            content: [
              {
                type: "input_text",
                text:
                  "Eres un asistente legal en español. " +
                  "Responde EXCLUSIVAMENTE usando los FRAGMENTOS proporcionados. " +
                  "Si hay fragmentos relevantes, escribe 1–2 frases que reflejen lo que dicen y cita los archivos entre corchetes, p. ej., [ley_larga.txt]. " +
                  "Si los fragmentos no contienen información suficiente, responde exactamente: \"No hay información suficiente en la base.\" " +
                  "La respuesta es referencial (no constituye asesoramiento legal).",
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text:
                  `Pregunta: ${message}\n\n` +
                  `FRAGMENTOS (${hits.length}):\n${fragmentsText}`,
              },
            ],
          },
        ],
      });

      stream.on("response.output_text.delta", (evt: any) => {
        if (closed) return;
        const delta = typeof evt?.delta === "string" ? evt.delta : "";
        send("response.output_text.delta", { delta });
      });

      stream.on("error", () => {
        if (closed) return;
        const fallback = `Según la evidencia localizada: ${citations.map(c => `[${c}]`).join(" ")}`;
        send("response.output_text.delta", { delta: fallback });
        try { res.write("data: [DONE]\n\n"); } catch {}
        try { res.end(); } catch {}
      });

      stream.on("response.completed", () => {
        if (closed) return;
        try { res.write("data: [DONE]\n\n"); } catch {}
        try { res.end(); } catch {}
      });
    } catch {
      // hard fallback if SDK/LLM call fails early
      if (!closed) {
        const fallback = `Según la evidencia localizada: ${citations.map(c => `[${c}]`).join(" ")}`;
        send("response.output_text.delta", { delta: fallback });
        try { res.write("data: [DONE]\n\n"); } catch {}
        try { res.end(); } catch {}
      }
    }
    return;
  }

  // POST (non-stream JSON)
  if (req.method === "POST") {
    const body = (req.body ?? {}) as any;
    return res.status(200).json({ ok: true, from: "pages-minimal", echo: body?.message ?? null });
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).end("Method Not Allowed");
}