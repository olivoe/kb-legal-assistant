// Health check / caching behavior
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const revalidate = 0;
export const fetchCache = "force-no-store";

// Simple CORS headers we’ll reuse
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
};

// Helper: unified no-cache headers + extras
function nocacheHeaders(
  contentType: "json" | "sse",
  extra?: Record<string, string>
) {
  return {
    "Content-Type":
      contentType === "sse"
        ? "text/event-stream; charset=utf-8"
        : "application/json; charset=utf-8",
    "Cache-Control":
      "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0, s-maxage=0",
    Pragma: "no-cache",
    Expires: "0",
    Connection: contentType === "sse" ? "keep-alive" : "close",
    ...CORS,
    ...(extra || {}),
  } as Record<string, string>;
}

// ✅ bundle embeddings at build-time (works on Vercel)
import emb from "../../../data/kb/embeddings.json";

type EmbedsFile = {
  model: string;
  dims: number;
  items: Array<{ id: string; file: string; start: number; end: number; embedding: number[] }>;
};
const embeddings = emb as EmbedsFile;

// ——— Redis (Upstash) ———
import { Redis } from "@upstash/redis";
const redis =
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
    ? new Redis({
        url: process.env.UPSTASH_REDIS_REST_URL!,
        token: process.env.UPSTASH_REDIS_REST_TOKEN!,
      })
    : null;

// Shape we store in Redis for cacheable (non-stream) responses
type CachedPayload = {
  ok: true;
  mode: "rag";
  receivedCount: number;
  lastRole: string | null;
  lastContent: string;
  kb: { indexFound: boolean; indexCount: number };
  limit: number;
  topk: Array<{ id: string; file: string; score: number; start: number; end: number }>;
  allowedFiles: string[];
  answer: string;
  citations: Array<{
    id: string;
    file: string;
    score: number;
    start: number;
    end: number;
    snippet: string;
  }>;
  // Minimal meta
  createdAt: number;
};

// GET /api/chat
export async function GET() {
  return new Response("chat route alive", {
    status: 200,
    headers: {
      "Content-Type": "text/plain",
      ...CORS,
    },
  });
}

// OPTIONS /api/chat
export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

// POST /api/chat
export async function POST(req: Request) {
  // accept ?limit= and ?debug=
  const url = new URL(req.url);
  const limit = Math.max(1, Math.min(10, Number(url.searchParams.get("limit") || 3)));
  const debug = url.searchParams.get("debug") === "1";
  const MIN_SCORE = 0.65; // tune 0.65–0.78 as you like

  let body: any = {};
  try {
    body = await req.json();
  } catch {}

  const msgs = Array.isArray(body?.messages) ? body.messages : [];
  const last = msgs.length ? msgs[msgs.length - 1] : null;
  const lastContent: string = (last?.content ?? "").toString();
  const lastRole = last?.role ?? null;

  // --- Deterministic SSE test mode (?test=1) ---
if ((request as any)?.nextUrl?.searchParams?.get?.("test") === "1") {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(`event: init\ndata: {"ok":true}\n\n`));
      const tokens = ["Hola", " ", "mundo", "."];
      let i = 0;
      const id = setInterval(() => {
        if (i >= tokens.length) {
          clearInterval(id);
          controller.enqueue(encoder.encode(`event: done\ndata: {}\n\n`));
          controller.close();
          return;
        }
        controller.enqueue(
          encoder.encode(
            `event: response.output_text.delta\ndata: {"delta":"${tokens[i++]}" }\n\n`
          )
        );
      }, 120);
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
// --- End test mode ---

  // normalize (remove accents) helper
  const deaccent = (s: string) => s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  const norm = (s: string) => deaccent(s).toLowerCase();

  // Deterministic request key (Step 3)
  function makeRequestKey(query: string, limit: number, minScore: number) {
    const base = `${norm(query)}::k${limit}::s${minScore}`;
    let h = 0;
    for (let i = 0; i < base.length; i++) h = (h * 31 + base.charCodeAt(i)) >>> 0;
    return `v1::req::${h.toString(16)}`;
  }

  // helper to read KB file text (txt/md/html/pdf) — prefer PDF, fallback to .txt sidecar
  async function readKbFileText(fname: string) {
    const { promises: fs } = await import("node:fs");
    const path = (await import("node:path")).default;
    const fpath = path.join(process.cwd(), "kb", fname);
    const ext = path.extname(fname).toLowerCase();

    if (ext === ".pdf") {
      try {
        const pdfjs: any = await import("pdfjs-dist/legacy/build/pdf.mjs");
        pdfjs.GlobalWorkerOptions.workerSrc = "pdfjs-dist/legacy/build/pdf.worker.mjs";
        (pdfjs as any).GlobalWorkerOptions.standardFontDataUrl = "pdfjs-dist/legacy/build/";

        const data = new Uint8Array(await fs.readFile(fpath));
        const doc = await pdfjs.getDocument({ data }).promise;
        let out = "";
        for (let pageNo = 1; pageNo <= doc.numPages; pageNo++) {
          const page = await doc.getPage(pageNo);
          const content = await page.getTextContent();
          out += content.items.map((it: any) => it.str).join(" ") + "\n";
        }
        if (out.trim()) return out;

        // If PDF extracted nothing, try sidecar .txt
        try {
          const alt = fpath.replace(/\.pdf$/i, ".txt");
          return await fs.readFile(alt, "utf8");
        } catch {
          return "";
        }
      } catch {
        // On error, try sidecar .txt before returning empty
        try {
          const alt = fpath.replace(/\.pdf$/i, ".txt");
          return await fs.readFile(alt, "utf8");
        } catch {
          return "";
        }
      }
    }

    if ([".txt", ".md", ".html"].includes(ext)) {
      return await fs.readFile(fpath, "utf8").catch(() => "");
    }

    return "";
  }

  // --- tiny embedding helpers (inline to avoid import hassles) ---
  async function embedTexts(texts: string[], model = "text-embedding-3-small"): Promise<number[][]> {
    if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is missing");
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model, input: texts }),
    });
    if (!res.ok)
      throw new Error(
        `OpenAI embeddings error ${res.status}: ${await res.text().catch(() => "")}`
      );
    const json = await res.json();
    return (json?.data ?? []).map((d: any) => d.embedding as number[]);
  }

  function cosineSim(a: number[], b: number[]): number {
    let dot = 0,
      na = 0,
      nb = 0;
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    if (na === 0 || nb === 0) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
  }

  // 👇 NEW: similaritySearch helper
  async function similaritySearch(query: string, k: number, minScore: number) {
    const [qvec] = await embedTexts([query]); // 1536 dims for text-embedding-3-small
    const scored = embeddings.items.map((it) => ({
      id: it.id,
      file: it.file,
      start: it.start,
      end: it.end,
      score: cosineSim(qvec, it.embedding),
    }));
    scored.sort((a, b) => b.score - a.score);

    let top = scored.filter((s) => s.score >= minScore).slice(0, k);
    if (top.length === 0) top = scored.slice(0, k);

    const topFixed = top.map((t) => ({
      ...t,
      score: Number(t.score.toFixed(5)),
    }));

    const allowedFiles = Array.from(new Set(topFixed.map((t) => t.file)));
    return { top: topFixed, allowedFiles };
  }

  // 👇 NEW: buildMessages helper (system + user) from top chunks
  async function buildMessages(question: string, top: Array<{id:string;file:string;start:number;end:number;score:number}>) {
    const contextLines: string[] = [];
    for (let i = 0; i < top.length; i++) {
      const t = top[i];
      let full = "";
      try {
        full = await readKbFileText(t.file);
      } catch {}
      let snippet = "";
      if (full) {
        const a = Math.max(0, Math.min(full.length, t.start));
        const b = Math.max(a, Math.min(full.length, t.end));
        snippet = full.slice(a, b);
        if (snippet.length > 1200) snippet = snippet.slice(0, 1200) + "…";
      } else {
        // Fallbacks for PDFs: try a sibling .txt with same basename
        const ext = t.file.split(".").pop()?.toLowerCase();
        if (ext === "pdf") {
          const base = t.file.replace(/\.pdf$/i, "");
          try {
            const alt = await readKbFileText(`${base}.txt`);
            if (alt) {
              const a = Math.max(0, Math.min(alt.length, t.start));
              const b = Math.max(a, Math.min(alt.length, t.end));
              snippet = alt.slice(a, b) || alt.slice(0, 800);
            }
          } catch {}
        }
        if (!snippet) {
          snippet = `(chunk ${t.id} ${t.start}-${t.end} from ${t.file})`;
        }
      }
      contextLines.push(`— file: ${t.file}\n— score: ${t.score}\n— snippet: ${snippet}`);
    }

    const ragContext = contextLines.join("\n\n");
    const allowedFiles = Array.from(new Set(top.map((t) => t.file)));

    const systemMsg = {
      role: "system",
      content: `Eres un asistente jurídico. Responde SOLO usando el CONTEXTO.
Si algo no está explícitamente en el CONTEXTO, di “No consta en el contexto.”.
Estilo: español claro, directo y conciso (máximo 4 oraciones).

CITAS (obligatorio si usas CONTEXTO):
- Usa exclusivamente archivos del listado de Permitidos.
- Cada oración que use datos del CONTEXTO termina con una cita entre corchetes con el nombre exacto del archivo, p. ej. [ley_pdf.pdf].
- Si una oración se basa en varias fuentes, añade varias citas sin texto extra: [ley_pdf.pdf][ley_larga.txt].
- No cites archivos que no estén en la lista de Permitidos.
- Si no usas CONTEXTO en una oración, no añadas cita.

Archivos Permitidos: ${allowedFiles.join(", ")}

NO INVENTES artículos, números ni resúmenes.`,
    } as const;

    const userMsg = {
      role: "user",
      content: `PREGUNTA: ${question}

CONTEXTO:
${ragContext}

FORMATO DE SALIDA (OBLIGATORIO):
- Entre 1 y 4 oraciones.
- Citas al final de cada oración basada en el CONTEXTO, con corchetes y sin comillas.
- Ejemplos:
  • "El artículo 123 regula los plazos. [ley_pdf.pdf]"
  • "También prevé excepciones. [ley_larga.txt][ley_pdf.pdf]"
  • "No consta en el contexto." (si no hay información suficiente)

Responde ahora cumpliendo estrictamente el FORMATO DE SALIDA.`,
    } as const;

    return { systemMsg, userMsg, allowedFiles, ragContext };
  }

  // Peek at KB index (still handy for debug mode)
  let kb = { indexFound: false, indexCount: 0 };
  let files: string[] = [];
  try {
    // optional — if missing, code still works
    const { promises: fs } = await import("node:fs");
    const path = (await import("node:path")).default;
    const indexPath = path.join(process.cwd(), "data", "kb", "kb_index.json");
    const raw = await fs.readFile(indexPath, "utf8").catch(() => "");
    if (raw) {
      const json = JSON.parse(raw);
      files = Array.isArray(json)
        ? json
        : Array.isArray(json?.files)
        ? json.files
        : json && typeof json === "object"
        ? Object.keys(json)
        : [];
      kb = { indexFound: true, indexCount: files.length };
    }

    const q = lastContent.trim();
    const requestKey = makeRequestKey(q, limit, MIN_SCORE);

    // ---------- DEBUG PATH: naive keyword/PDF scan ----------
    if (debug && q && files.length) {
      const qn = norm(q);
      let matches: Array<{ file: string; score: number; line?: string }> = [];

      for (const fname of files) {
        const path = (await import("node:path")).default;
        const ext = path.extname(fname).toLowerCase();

        // Debug scan: avoid pdfjs in serverless. We’ll only scan text-like files here.
        if (![".txt", ".md", ".html"].includes(ext)) continue;

        let text = "";
        try {
          text = await readKbFileText(fname);
        } catch {
          continue;
        }
        if (!text) continue;

        const lower = norm(text);
        let score = 0,
          idx = 0;
        while ((idx = lower.indexOf(qn, idx)) !== -1) {
          score++;
          idx += qn.length || 1;
        }
        if (score > 0) {
          const line = text.split(/\r?\n/).find((l) => norm(l).includes(qn));
          matches.push({ file: fname, score, line });
        }
      }

      matches.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
      matches = matches.slice(0, limit);

      return new Response(
        JSON.stringify({
          ok: true,
          mode: "minimal+scan",
          receivedCount: msgs.length,
          lastRole,
          lastContent,
          kb,
          limit,
          matches,
        }),
        {
          status: 200,
          headers: nocacheHeaders("json", { "x-cache": "MISS", "x-cache-key": requestKey }),
        }
      );
    }

    // ---------- RAG FAST-PATH: top-k chunks via embeddings ----------
    if (q) {
      // ——— Redis READ for non-stream requests ———
      const isStream = url.searchParams.get("stream") === "1";

      if (!isStream && redis) {
        try {
          const cached = (await redis.get<CachedPayload>(requestKey)) || null;
          if (cached) {
            return new Response(JSON.stringify(cached), {
              status: 200,
              headers: nocacheHeaders("json", { "x-cache": "HIT", "x-cache-key": requestKey }),
            });
          }
        } catch {
          // ignore redis errors
        }
      }

      // 👇 NEW: use similaritySearch
      const { top, allowedFiles } = await similaritySearch(q, limit, MIN_SCORE);

      // ---------------- STREAM BRANCH ----------------
      const stream = isStream;

      if (stream) {
        // If you WANT to serve cached SSE, do it here. (Read again and emit.)
        if (redis) {
          try {
            const cached = (await redis.get<CachedPayload>(requestKey)) || null;
            if (cached) {
              // stream cached answer as SSE
              const encoder = new TextEncoder();
              const stream = new ReadableStream({
                start(controller) {
                  const send = (event: string, data: any) => {
                    controller.enqueue(encoder.encode(`event: ${event}\n`));
                    controller.enqueue(
                      encoder.encode(
                        `data: ${
                          typeof data === "string" ? data : JSON.stringify(data)
                        }\n\n`
                      )
                    );
                  };
                  // Tokens (naively character by character to simulate stream)
                  for (const ch of cached.answer) {
                    send("response.output_text.delta", { delta: ch });
                  }
                  // Completed payload
                  const { createdAt, ...rest } = cached;
                  send("response.completed", rest);
                  controller.close();
                },
              });
              return new Response(stream, {
                status: 200,
                headers: nocacheHeaders("sse", {
                  "x-cache": "HIT",
                  "x-cache-key": requestKey,
                }),
              });
            }
          } catch {
            // ignore
          }
        }

        // 3) Graceful empty-context behavior
        if (top.length === 0) {
          const msg = "No consta en el contexto.";
          const encoder = new TextEncoder();
          const body = new ReadableStream({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ choices: [{ delta: { content: msg } }] })}\n\n`
                )
              );
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    choices: [{ delta: {}, finish_reason: "stop" }],
                  })}\n\n`
                )
              );
              controller.close();
            },
          });
          return new Response(body, {
            status: 200,
            headers: nocacheHeaders("sse", {
              "x-cache": "MISS",
              "x-cache-key": requestKey,
            }),
          });
        }

        // 👇 NEW: build prompt messages
        const { systemMsg, userMsg } = await buildMessages(q, top);

        if (!process.env.OPENAI_API_KEY) {
          return new Response('event: error\ndata: {"error":"OPENAI_API_KEY missing"}\n\n', {
            status: 200,
            headers: nocacheHeaders("sse", {
              "x-cache": "MISS",
              "x-cache-key": requestKey,
            }),
          });
        }

        const upstream = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "gpt-4o-mini-2024-07-18",
            temperature: 0.2,
            stream: true,
            messages: [systemMsg, userMsg],
          }),
        });

        if (!upstream.ok || !upstream.body) {
          const msg = await upstream.text().catch(() => `${upstream.status} upstream error`);
          return new Response(`event: error\ndata: ${JSON.stringify({ error: msg })}\n\n`, {
            status: 200,
            headers: nocacheHeaders("sse", {
              "x-cache": "MISS",
              "x-cache-key": requestKey,
            }),
          });
        }

        // 4b) Proxy upstream SSE with our headers
        return new Response(upstream.body, {
          status: 200,
          headers: nocacheHeaders("sse", {
            "x-cache": "MISS",
            "x-cache-key": requestKey,
          }),
        });
      } // end stream branch

      // ---------------- NON-STREAM: compose answer + return JSON ----------------
      const { systemMsg: systemMsgNS, userMsg: userMsgNS } = await buildMessages(q, top);

      let answerText = "No consta en el contexto.";
      if (process.env.OPENAI_API_KEY) {
        const upstreamNS = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "gpt-4o-mini-2024-07-18",
            temperature: 0.2,
            stream: false,
            messages: [systemMsgNS, userMsgNS],
          }),
        });
        if (upstreamNS.ok) {
          const data = await upstreamNS.json().catch(() => null);
          const maybe = data?.choices?.[0]?.message?.content;
          if (typeof maybe === "string" && maybe.trim().length > 0) {
            answerText = maybe.trim();
          }
        }
      }

      // Build citations payload from top chunks
      const citations = await (async () => {
        const out: Array<{
          id: string;
          file: string;
          score: number;
          start: number;
          end: number;
          snippet: string;
        }> = [];
        for (const t of top) {
          let full = "";
          try {
            full = await readKbFileText(t.file);
          } catch {}
          let snippet = "";
          if (full) {
            const a = Math.max(0, Math.min(full.length, t.start));
            const b = Math.max(a, Math.min(full.length, t.end));
            snippet = full.slice(a, b);
          }
          // fallback for PDFs (try sidecar .txt) or empty reads
          if (!snippet) {
            const isPdf = /\.pdf$/i.test(t.file);
            if (isPdf) {
              try {
                const alt = await readKbFileText(t.file.replace(/\.pdf$/i, ".txt"));
                if (alt) {
                  const a = Math.max(0, Math.min(alt.length, t.start));
                  const b = Math.max(a, Math.min(alt.length, t.end));
                  snippet = alt.slice(a, b) || alt.slice(0, 800);
                }
              } catch {}
            }
          }
          if (!snippet) snippet = ""; // keep empty if we truly can't read

          // keep snippets compact
          snippet = snippet.trim();
          if (snippet.length > 400) snippet = snippet.slice(0, 400) + "…";

          out.push({
            id: t.id,
            file: t.file,
            score: t.score,
            start: t.start,
            end: t.end,
            snippet,
          });
        }
        return out;
      })();

      // Compose cacheable JSON payload
      const payload: CachedPayload = {
        ok: true,
        mode: "rag",
        receivedCount: msgs.length,
        lastRole,
        lastContent,
        kb,
        limit,
        topk: top,
        allowedFiles,
        answer: answerText,
        citations,
        createdAt: Date.now(),
      };

      // ——— Redis WRITE ———
      if (redis) {
        try {
          // 6h TTL
          await redis.set(requestKey, payload, { ex: 60 * 60 * 6 });
        } catch {
          // ignore redis errors
        }
      }

      // 4c) Non-stream JSON with our headers
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: nocacheHeaders("json", {
          "x-cache": "MISS",
          "x-cache-key": requestKey,
        }),
      });
    }
  } catch {
    // fall through
  }

  // 4d) No query provided
  return new Response(
    JSON.stringify({
      ok: true,
      mode: "rag-placeholder",
      receivedCount: 0,
      lastRole: null,
      lastContent: "",
      kb: { indexFound: false, indexCount: 0 },
      note: "RAG path idle (no query).",
    }),
    {
      status: 200,
      headers: nocacheHeaders("json", { "x-cache": "MISS", "x-cache-key": "none" }),
    }
  );
}