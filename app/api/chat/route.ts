export const dynamic = 'force-dynamic';

// Health check
export const dynamic = 'force-dynamic';

export async function GET() {
  return new Response('chat route alive', {
    status: 200,
    headers: { 'Content-Type': 'text/plain' },
  });
}

export async function POST(req: Request) {
  // accept ?limit= and ?debug=
  const url = new URL(req.url);
  const limit = Math.max(1, Math.min(10, Number(url.searchParams.get("limit") || 3)));
  const debug = url.searchParams.get("debug") === "1";
  const MIN_SCORE = 0.72; // tune 0.68–0.78 as you like

  let body: any = {};
  try { body = await req.json(); } catch {}
  const msgs = Array.isArray(body?.messages) ? body.messages : [];
  const last = msgs.length ? msgs[msgs.length - 1] : null;
  const lastContent: string = (last?.content ?? "").toString();
  const lastRole = last?.role ?? null;

  // normalize (remove accents) helper
  const deaccent = (s: string) => s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  const norm = (s: string) => deaccent(s).toLowerCase();

  // helper to read KB file text (txt/md/html/pdf)
  async function readKbFileText(fname: string) {
    const { promises: fs } = await import("node:fs");
    const path = (await import("node:path")).default;
    const fpath = path.join(process.cwd(), "kb", fname);
    const ext = path.extname(fname).toLowerCase();

    if (ext === ".pdf") {
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
      return out;
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
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, input: texts }),
    });
    if (!res.ok) throw new Error(`OpenAI embeddings error ${res.status}: ${await res.text().catch(()=> "")}`);
    const json = await res.json();
    return (json?.data ?? []).map((d: any) => d.embedding as number[]);
  }
  function cosineSim(a: number[], b: number[]): number {
    let dot = 0, na = 0, nb = 0;
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) { dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
    if (na === 0 || nb === 0) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
  }

  // Peek at KB index (still handy for debug mode)
  let kb = { indexFound: false, indexCount: 0 };
  let files: string[] = [];
  try {
    const { promises: fs } = await import("node:fs");
    const path = (await import("node:path")).default;
    const indexPath = path.join(process.cwd(), "data", "kb", "kb_index.json");
    const raw = await fs.readFile(indexPath, "utf8").catch(() => "");
    if (raw) {
      const json = JSON.parse(raw);
      files = Array.isArray(json) ? json
        : Array.isArray(json?.files) ? json.files
        : json && typeof json === "object" ? Object.keys(json) : [];
      kb = { indexFound: true, indexCount: files.length };
    }

    const q = lastContent.trim();

    // ---------- DEBUG PATH: naive keyword/PDF scan ----------
    if (debug && q && files.length) {
      const qn = norm(q);
      let matches: Array<{file: string; score: number; line?: string}> = [];

      for (const fname of files) {
        const path = (await import("node:path")).default;
        const ext = path.extname(fname).toLowerCase();
        if (![".txt", ".md", ".html", ".pdf"].includes(ext)) continue;

        const text = await readKbFileText(fname);
        if (!text) continue;

        const lower = norm(text);
        let score = 0, idx = 0;
        while ((idx = lower.indexOf(qn, idx)) !== -1) {
          score++; idx += qn.length || 1;
        }
        if (score > 0) {
          const line = text.split(/\r?\n/).find(l => norm(l).includes(qn));
          matches.push({ file: fname, score, line });
        }
      }

      matches.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
      matches = matches.slice(0, limit);

      return new Response(JSON.stringify({
        ok: true,
        mode: "minimal+scan",
        receivedCount: msgs.length,
        lastRole,
        lastContent,
        kb,
        limit,
        matches
      }), { status: 200, headers: { "Content-Type": "application/json" }});
    }

    // ---------- RAG FAST-PATH: top-k chunks via embeddings ----------
    if (q) {
      const { promises: fs } = await import("node:fs");
      const path = (await import("node:path")).default;
      const embPath = path.join(process.cwd(), "data", "kb", "embeddings.json");
      const rawEmb = await fs.readFile(embPath, "utf8").catch(() => "");
      if (!rawEmb) {
        return new Response(JSON.stringify({
          ok: false, mode: "rag", error: "embeddings-missing"
        }), { status: 200, headers: { "Content-Type": "application/json" }});
      }
      const emb = JSON.parse(rawEmb) as {
        model: string; dims: number; items: Array<{ id: string; file: string; start: number; end: number; embedding: number[] }>
      };
      const [qvec] = await embedTexts([q]); // 1536 dims for text-embedding-3-small
      // score all chunks (could be optimized with ANN later)
      const scored = emb.items.map(it => ({ ...it, score: cosineSim(qvec, it.embedding) }));
      scored.sort((a, b) => b.score - a.score);
      // keep only relevant chunks
      const topFiltered = scored.filter(s => s.score >= MIN_SCORE).slice(0, limit);

      // for JSON responses and for building context/snippets
      const top = topFiltered.map(s => ({
        id: s.id, file: s.file, score: Number(s.score.toFixed(5)), start: s.start, end: s.end
      }));

      // ---------------- STREAM BRANCH ----------------
      const stream = url.searchParams.get("stream") === "1";

      if (stream) {
        // 3) Graceful empty-context behavior
        if (top.length === 0) {
          const msg = "No consta en el contexto.";
          const encoder = new TextEncoder();
          const body = new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices:[{ delta:{ content: msg } }] })}\n\n`));
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices:[{ delta:{} , finish_reason:"stop"}] })}\n\n`));
              controller.close();
            }
          });
          return new Response(body, {
            status: 200,
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache, no-transform",
              Connection: "keep-alive",
              "Access-Control-Allow-Origin": "*",
            },
          });
        }

        // Build compact, grounded context from actual chunk text (PDFs included)
        const contextLines: string[] = [];
        for (let i = 0; i < top.length; i++) {
          const t = top[i];
          let full = "";
          try { full = await readKbFileText(t.file); } catch {}
          let snippet = "";
          if (full) {
            const a = Math.max(0, Math.min(full.length, t.start));
            const b = Math.max(a, Math.min(full.length, t.end));
            snippet = full.slice(a, b);
            if (snippet.length > 1200) snippet = snippet.slice(0, 1200) + "…";
          } else {
            snippet = `(chunk ${t.id} ${t.start}-${t.end} from ${t.file})`;
          }
          contextLines.push(`— file: ${t.file}\n— score: ${t.score}\n— snippet: ${snippet}`);
        }
        const ragContext = contextLines.join("\n\n");

        // System + user messages with strict OUTPUT FORMAT + examples
        const systemMsg = {
          role: "system",
          content:
`Eres un asistente jurídico. Responde SOLO usando el CONTEXTO.
Si algo no está explícitamente en el CONTEXTO, di que no consta.
Estilo: español claro, directo y conciso (máximo 4 oraciones).
CITAS:
- Cada oración que use datos del CONTEXTO debe terminar con una cita entre corchetes con el nombre exacto del archivo, p. ej. [ley_pdf.pdf].
- No uses comillas ni texto extra dentro de los corchetes. Solo el nombre del archivo.
- Si una oración se basa en varias fuentes, añade varias citas, p. ej. [ley_pdf.pdf][ley_larga.txt].
- Si no usas el CONTEXTO en una oración, no añadas cita.
NO INVENTES artículos, números ni resúmenes.`
        } as const;

        const userMsg = {
          role: "user",
          content:
`PREGUNTA: ${lastContent}

CONTEXTO:
${ragContext}

FORMATO DE SALIDA (OBLIGATORIO):
- Entre 1 y 4 oraciones.
- Citas al final de cada oración basada en el CONTEXTO, con corchetes y sin comillas.
- Ejemplos:
  • "El artículo 123 regula los plazos. [ley_pdf.pdf]"
  • "También prevé excepciones. [ley_larga.txt][ley_pdf.pdf]"
  • "No consta en el contexto." (si no hay información suficiente)

Responde ahora cumpliendo estrictamente el FORMATO DE SALIDA.`
        } as const;

        if (!process.env.OPENAI_API_KEY) {
          return new Response("event: error\ndata: {\"error\":\"OPENAI_API_KEY missing\"}\n\n", {
            status: 200,
            headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
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
            headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
          });
        }

        return new Response(upstream.body, {
          status: 200,
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            "Access-Control-Allow-Origin": "*",
          },
        });
      } // end stream branch

      // ---------------- NON-STREAM JSON (returns topk) ----------------
      return new Response(JSON.stringify({
        ok: true,
        mode: "rag",
        receivedCount: msgs.length,
        lastRole,
        lastContent,
        kb,
        limit,
        topk: top
      }), { status: 200, headers: { "Content-Type": "application/json" }});
    }
  } catch {
    // fall through
  }

  // No query provided
  return new Response(JSON.stringify({
    ok: true,
    mode: debug ? "minimal" : "rag-placeholder",
    receivedCount: msgs.length,
    lastRole,
    lastContent,
    kb,
    note: debug
      ? "No query or no index; skipping naive scan."
      : "RAG path idle (no query)."
  }), { status: 200, headers: { "Content-Type": "application/json" }});
}