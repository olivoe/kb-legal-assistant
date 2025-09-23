export const dynamic = "force-dynamic";

/** ---------- small utilities ---------- */
const deaccent = (s: string) => s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
const norm = (s: string) => deaccent(s).replace(/\s+/g, " ").trim();

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

function chunkText(text: string, opts = { size: 800, overlap: 120 }) {
  const { size, overlap } = opts;
  const cleaned = norm(text);
  const out: { start: number; end: number; text: string }[] = [];
  if (!cleaned) return out;
  let i = 0;
  while (i < cleaned.length) {
    const start = i;
    const end = Math.min(cleaned.length, i + size);
    out.push({ start, end, text: cleaned.slice(start, end) });
    if (end === cleaned.length) break;
    i = end - overlap;
    if (i < 0) i = 0;
  }
  return out;
}

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

/** ---------- handler ---------- */
export async function POST(req: Request) {
  // optional limits via query: ?maxFiles=20&maxChunks=1000
  const url = new URL(req.url);
  const maxFiles = Math.max(1, Math.min(200, Number(url.searchParams.get("maxFiles") || 50)));
  const maxChunks = Math.max(1, Math.min(5000, Number(url.searchParams.get("maxChunks") || 1500)));

  const { promises: fs } = await import("node:fs");
  const path = (await import("node:path")).default;

  // load index
  const indexPath = path.join(process.cwd(), "data", "kb", "kb_index.json");
  const raw = await fs.readFile(indexPath, "utf8").catch(() => "");
  if (!raw) {
    return new Response(JSON.stringify({ ok: false, error: "kb-index-missing" }), {
      status: 200, headers: { "Content-Type": "application/json" }
    });
  }
  const json = JSON.parse(raw);
  let files: string[] = Array.isArray(json) ? json
    : Array.isArray(json?.files) ? json.files
    : json && typeof json === "object" ? Object.keys(json) : [];
  // support these types only
  files = files.filter(f => [".txt",".md",".html",".pdf"].includes(path.extname(f).toLowerCase())).slice(0, maxFiles);

  // chunk
  const allChunks: { id: string; file: string; start: number; end: number; text: string }[] = [];
  for (const file of files) {
    const text = await readKbFileText(file);
    if (!text) continue;
    const chunks = chunkText(text);
    chunks.forEach((c, idx) => {
      allChunks.push({ id: `${file}#${idx}`, file, start: c.start, end: c.end, text: c.text });
    });
    if (allChunks.length >= maxChunks) break;
  }

  if (allChunks.length === 0) {
    return new Response(JSON.stringify({ ok: false, error: "no-chunks" }), {
      status: 200, headers: { "Content-Type": "application/json" }
    });
  }

  // embed in batches to avoid large payloads
  const BATCH = 64;
  const vectors: number[][] = [];
  for (let i = 0; i < allChunks.length; i += BATCH) {
    const batch = allChunks.slice(i, i + BATCH);
    const embs = await embedTexts(batch.map(b => b.text));
    vectors.push(...embs);
  }

  // write out embeddings file
  const out = allChunks.map((c, i) => ({
    id: c.id, file: c.file, start: c.start, end: c.end, embedding: vectors[i]
  }));

  const outDir = path.join(process.cwd(), "data", "kb");
  await fs.mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, "embeddings.json");
  await fs.writeFile(outPath, JSON.stringify({ model: "text-embedding-3-small", dims: vectors[0]?.length ?? 0, items: out }, null, 2));

  return new Response(JSON.stringify({
    ok: true,
    filesCount: files.length,
    chunks: allChunks.length,
    outPath
  }), { status: 200, headers: { "Content-Type": "application/json" }});
}
