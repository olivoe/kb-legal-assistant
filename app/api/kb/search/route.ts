export const dynamic = "force-dynamic";

// Normalize accents
const deaccent = (s: string) => s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
const norm = (s: string) => deaccent(s).toLowerCase();

// Read KB file text (txt/md/html/pdf)
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

export async function GET(req: Request) {
  const url = new URL(req.url);
  const q = (url.searchParams.get("q") || "").trim();
  const limit = Math.max(1, Math.min(10, Number(url.searchParams.get("limit") || 5)));

  // load index
  const { promises: fs } = await import("node:fs");
  const path = (await import("node:path")).default;
  const indexPath = path.join(process.cwd(), "data", "kb", "kb_index.json");

  let files: string[] = [];
  try {
    const raw = await fs.readFile(indexPath, "utf8").catch(() => "");
    if (raw) {
      const json = JSON.parse(raw);
      files = Array.isArray(json) ? json
        : Array.isArray(json?.files) ? json.files
        : json && typeof json === "object" ? Object.keys(json) : [];
    }
  } catch {}

  if (!q || files.length === 0) {
    return new Response(JSON.stringify({
      ok: true, q, limit, count: 0, matches: [],
      note: !q ? "Provide ?q=query" : "KB index empty"
    }), { status: 200, headers: { "Content-Type": "application/json" }});
  }

  const qn = norm(q);
  let matches: Array<{ file: string; score: number; line?: string }> = [];

  for (const fname of files) {
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
    ok: true, q, limit, count: matches.length, matches
  }), { status: 200, headers: { "Content-Type": "application/json" }});
}
