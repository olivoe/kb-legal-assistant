// scripts/build_kb_index.mjs
import fs from "node:fs/promises";
import fssync from "node:fs";
import path from "node:path";

// Config
const KB_DIR = process.env.KB_DIR || "./data/kb";
const OUT_PATH = "./data/kb_index.json";

// --- Helpers (match your server code behaviors) ---
function slug(s) {
  return s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();
}

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function extractPdfTextFromBuffer(buf) {
  try {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    if (pdfjs.GlobalWorkerOptions) {
      pdfjs.GlobalWorkerOptions.workerSrc = undefined;
    }
    const task = pdfjs.getDocument({ data: new Uint8Array(buf) });
    const pdf = await task.promise;

    let out = "";
    const maxPages = Math.min(pdf.numPages, 100); // bump if you like
    for (let i = 1; i <= maxPages; i++) {
      const p = await pdf.getPage(i);
      const tc = await p.getTextContent();
      out += tc.items.map((it) => it.str ?? "").join(" ") + "\n";
    }
    return out.trim();
  } catch (e) {
    console.error("[pdf] failed:", e?.message || e);
    return "";
  }
}

async function readFileAsText(fullPath) {
  try {
    const ext = path.extname(fullPath).toLowerCase();
    const buf = await fs.readFile(fullPath);

    if (ext === ".pdf") {
      return await extractPdfTextFromBuffer(buf);
    }
    if (ext === ".html" || ext === ".htm") {
      const stripped = htmlToText(buf.toString("utf8"));
      return stripped;
    }
    if (ext === ".docx") {
      try {
        const mod = await import("mammoth");
        const mammoth = mod.default || mod;
        const result = await mammoth.extractRawText({ buffer: buf });
        return result?.value || buf.toString("utf8");
      } catch {
        return buf.toString("utf8");
      }
    }
    // md, txt, etc.
    return buf.toString("utf8");
  } catch {
    return "";
  }
}

function* walk(dir) {
  const list = fssync.readdirSync(dir, { withFileTypes: true });
  for (const e of list) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      yield* walk(full);
    } else {
      yield full;
    }
  }
}

function shouldIndex(file) {
  return /\.(txt|md|markdown|pdf|docx|html?|htm)$/i.test(file);
}

// Simple char-based chunking; keep it similar to your server’s expectations
function chunkText(text, size = 1800, overlap = 200) {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return [];
  const chunks = [];
  let i = 0;
  while (i < t.length) {
    const end = Math.min(t.length, i + size);
    chunks.push(t.slice(i, end));
    if (end === t.length) break;
    i = end - overlap;
  }
  return chunks;
}

async function main() {
  const absKB = path.resolve(process.cwd(), KB_DIR);
  console.log("[KB] scanning", absKB);

  const allFiles = [];
  for (const f of walk(absKB)) {
    if (shouldIndex(f)) allFiles.push(f);
  }
  if (!allFiles.length) {
    console.log("[KB] no indexable files found.");
    process.exit(0);
  }

  let fileCount = 0, pdfCount = 0, docxCount = 0, htmlCount = 0, txtCount = 0, mdCount = 0;
  const chunks = [];

  for (const full of allFiles) {
    const rel = path.relative(absKB, full);
    const ext = path.extname(full).toLowerCase();
    fileCount++;

    if (ext === ".pdf") pdfCount++;
    else if (ext === ".docx") docxCount++;
    else if (ext === ".html" || ext === ".htm") htmlCount++;
    else if (ext === ".md" || ext === ".markdown") mdCount++;
    else txtCount++;

    const text = await readFileAsText(full);
    if (!text) continue;

    const parts = chunkText(text);
    for (const p of parts) {
      // store relative to KB dir, because your app expects relative file names
      chunks.push({ file: rel, text: p });
    }
    console.log(`[KB] ${rel}: ${parts.length} chunks`);
  }

  const outObj = { chunks };
  await fs.mkdir(path.dirname(OUT_PATH), { recursive: true });
  await fs.writeFile(OUT_PATH, JSON.stringify(outObj, null, 2), "utf8");

  console.log("\n[KB] index written:", OUT_PATH);
  console.log(
    `[KB] files=${fileCount} | pdf=${pdfCount} docx=${docxCount} html=${htmlCount} md=${mdCount} txt=${txtCount} | chunks=${chunks.length}`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});