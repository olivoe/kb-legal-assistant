/* Build a simple embeddings index from the local KB.
   Output: ./data/kb_index.json

   Env you can tweak:
   - KB_DIR (default: ./data/kb)
   - EMBEDDING_MODEL (default: text-embedding-3-small)
   - CHUNK_CHARS (default: 1000)
   - CHUNK_OVERLAP (default: 200)
*/

import "dotenv/config"; // loads .env by default
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import he from "he";
import { embedMany } from "@/lib/embeddings";

/* Also load .env.local explicitly (if present) */
try {
  const local = path.resolve(process.cwd(), ".env.local");
  if (fs.existsSync(local)) {
    const dotenv = await import("dotenv");
    dotenv.config({ path: local });
  }
} catch {}

/* -------- Config -------- */
const KB_DIR = process.env.KB_DIR || "./data/kb";
const OUT_PATH = "./data/kb_index.json";
const CHUNK_CHARS = Number(process.env.CHUNK_CHARS || 1000);
const CHUNK_OVERLAP = Number(process.env.CHUNK_OVERLAP || 200);
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || "text-embedding-3-small";

/* -------- Utilities -------- */
function sha1(s: string): string {
  return crypto.createHash("sha1").update(s).digest("hex");
}

function slug(s: string) {
  return s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().trim();
}

function htmlToText(html: string): string {
  return he
    .decode(
      html
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
    )
    .replace(/\s+/g, " ")
    .trim();
}

/** Best-effort PDF text (optional dep) */
async function extractPdfTextFromBuffer(buf: Uint8Array): Promise<string> {
  try {
    const pdfjs: any = await import("pdfjs-dist/legacy/build/pdf.mjs");
    if (pdfjs.GlobalWorkerOptions) {
      pdfjs.GlobalWorkerOptions.workerSrc = undefined as any;
    }
    const task = pdfjs.getDocument({ data: buf });
    const pdf = await task.promise;

    let out = "";
    const maxPages = Math.min(pdf.numPages, 40);
    for (let i = 1; i <= maxPages; i++) {
      const p = await pdf.getPage(i);
      const tc = await p.getTextContent();
      out += tc.items.map((it: any) => it.str ?? "").join(" ") + "\n";
    }
    return out.trim();
  } catch {
    return ""; // ok to skip if not installed
  }
}

/** Read file to plain text regardless of extension (best effort) */
async function readLocalFileAsText(fullPath: string): Promise<string | null> {
  try {
    const ext = path.extname(fullPath).toLowerCase();
    const buf = await fsp.readFile(fullPath);

    if (ext === ".pdf") {
      const txt = await extractPdfTextFromBuffer(new Uint8Array(buf));
      return txt || null;
    }
    if (ext === ".html" || ext === ".htm") {
      return htmlToText(buf.toString("utf8"));
    }
    if (ext === ".docx") {
      // optional dep: mammoth
      try {
        // @ts-ignore
        const mod = await import("mammoth");
        const mammoth = (mod as any).default || (mod as any);
        const result = await mammoth.extractRawText({ buffer: buf });
        return result?.value || null;
      } catch {
        // fallback to raw text (may not be pretty)
        return buf.toString("utf8");
      }
    }
    return buf.toString("utf8");
  } catch {
    return null;
  }
}

function listKbFiles(dir: string): string[] {
  const out: string[] = [];
  function walk(d: string) {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.(txt|md|markdown|pdf|docx|html?|htm)$/i.test(e.name)) {
        out.push(path.relative(dir, full));
      }
    }
  }
  walk(dir);
  return out.sort();
}

/** Simple character-based chunking with overlap */
function chunkText(text: string, size = CHUNK_CHARS, overlap = CHUNK_OVERLAP): { start: number; end: number; text: string }[] {
  const chunks: { start: number; end: number; text: string }[] = [];
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return chunks;

  let i = 0;
  while (i < clean.length) {
    const start = i;
    const end = Math.min(clean.length, i + size);
    chunks.push({ start, end, text: clean.slice(start, end) });
    if (end === clean.length) break;
    i = end - overlap;
    if (i < 0) i = 0;
  }
  return chunks;
}

/* -------- Index Types -------- */
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

/* -------- Main builder -------- */
async function main() {
  const kbAbs = path.resolve(process.cwd(), KB_DIR);
  if (!fs.existsSync(kbAbs)) {
    console.error(`KB_DIR not found: ${kbAbs}`);
    process.exit(1);
  }

  const files = listKbFiles(kbAbs);
  if (!files.length) {
    console.warn("No KB files found.");
  }

  // Read & chunk
  const allChunks: { file: string; start: number; end: number; text: string }[] = [];
  const failures: string[] = [];
  for (const rel of files) {
    const full = path.join(kbAbs, rel);
    const txt = await readLocalFileAsText(full);
    if (!txt) {
      failures.push(rel);
      continue;
    }
    const chunks = chunkText(txt);
    for (const c of chunks) {
      allChunks.push({ file: rel, start: c.start, end: c.end, text: c.text });
    }
  }

  console.log(`Files: ${files.length}, chunks to embed: ${allChunks.length}`);
  if (failures.length) console.log(`(Skipped ${failures.length} unreadable files)`);

  // Embed
  const embeddings = await embedMany(allChunks.map((c) => c.text));

  // Build index objects
  const outChunks: KBChunk[] = allChunks.map((c, i) => {
    const idBase = `${c.file}#${c.start}-${c.end}`;
    return {
      id: sha1(idBase),
      file: c.file,
      chunk: i,
      start: c.start,
      end: c.end,
      text: c.text,
      embedding: embeddings[i],
    };
  });

  // Files digest for cache-busting / linkage
  const filesDigest = sha1(JSON.stringify(files));

  const index: KBIndex = {
    meta: {
      kbDir: KB_DIR,
      builtAt: new Date().toISOString(),
      embeddingModel: EMBEDDING_MODEL,
      chunkChars: CHUNK_CHARS,
      chunkOverlap: CHUNK_OVERLAP,
      filesDigest,
      fileCount: files.length,
      chunkCount: outChunks.length,
    },
    chunks: outChunks,
  };

  // Ensure data dir
  const dataDir = path.resolve(process.cwd(), "data");
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  const outAbs = path.resolve(process.cwd(), OUT_PATH);
  await fsp.writeFile(outAbs, JSON.stringify(index), "utf8");

  console.log(`✅ Wrote ${outChunks.length} chunks to ${OUT_PATH}`);
}

main().catch((err) => {
  console.error("Build failed:", err);
  process.exit(1);
});