// src/app/api/kb/files/route.ts
import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import OpenAI from "openai";

type FileRow = {
  filename: string;
  sizeBytes: number;
  modifiedAt: string | null;
  file_id: string | null;
  preview: string | null;
};

/** Extract simple text preview from PDFs using pdfjs-dist (Node/SSR friendly) */
async function extractPdfText(buf: Uint8Array): Promise<string> {
  const pdfjsLib: any = await import("pdfjs-dist/legacy/build/pdf.mjs");

  // In Node we don’t need a worker
  if (pdfjsLib.GlobalWorkerOptions) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = undefined as any;
  }

  const loadingTask = pdfjsLib.getDocument({ data: buf });
  const pdf = await loadingTask.promise;

  let text = "";
  const maxPages = Math.min(pdf.numPages, 30); // safety cap
  for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const content = await page.getTextContent();
    const pageText = content.items.map((it: any) => it.str ?? "").join(" ");
    text += pageText + "\n";
  }

  try {
    if (typeof pdf.cleanup === "function") await pdf.cleanup();
  } catch {
    /* noop */
  }

  return text.trim();
}

function isSupportedExt(fileName: string): boolean {
  const ext = path.extname(fileName).toLowerCase();
  return [".txt", ".md", ".markdown", ".pdf", ".html", ".htm"].includes(ext);
}

/** List files from the local KB directory and build short previews */
async function listLocal(): Promise<FileRow[]> {
  const kbDir = process.env.KB_LOCAL_DIR || "data/kb";
  const root = path.join(process.cwd(), kbDir);

  let entries: fs.Dirent[] = [];
  try {
    entries = await fs.promises.readdir(root, { withFileTypes: true });
  } catch {
    // directory may not exist yet
    return [];
  }

  const rows: FileRow[] = [];
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    if (!isSupportedExt(ent.name)) continue;

    const full = path.join(root, ent.name);

    let size = 0;
    let modifiedAt: string | null = null;
    try {
      const stat = await fs.promises.stat(full);
      size = stat.size;
      modifiedAt = stat.mtime.toISOString();
    } catch {
      // ignore stat errors, still show filename
    }

    let preview: string | null = null;
    try {
      const buf = await fs.promises.readFile(full);
      const ext = path.extname(ent.name).toLowerCase();
      if (ext === ".pdf") {
        const text = await extractPdfText(new Uint8Array(buf));
        preview = text.slice(0, 200) || null;
      } else {
        const text = buf.toString("utf8");
        preview = text.slice(0, 200);
      }
    } catch {
      // ignore preview errors
    }

    rows.push({
      filename: ent.name,
      sizeBytes: size,
      modifiedAt,
      file_id: null,
      preview,
    });
  }

  return rows;
}

/** List files from an OpenAI vector store (metadata only; no preview here) */
async function listOpenAI(): Promise<FileRow[]> {
  const apiKey = process.env.OPENAI_API_KEY || "";
  const storeId = process.env.OPENAI_VECTOR_STORE_ID || "";
  if (!apiKey || !storeId) return [];

  const client = new OpenAI({ apiKey });

  // Basic list (avoid unknown params to keep it compatible)
  const page = await client.vectorStores.files.list(storeId);

  const rows: FileRow[] = [];
  for (const f of page.data) {
    rows.push({
      filename: (f as any).filename ?? (f as any).id, // some SDK versions expose filename
      sizeBytes: (f as any).bytes ?? 0,
      modifiedAt:
        (f as any).created_at != null
          ? new Date((f as any).created_at * 1000).toISOString()
          : null,
      file_id: (f as any).id ?? null,
      preview: null, // previews not returned by API
    });
  }
  return rows;
}

/** GET /api/kb/files */
export async function GET() {
  const mode = (process.env.KB_MODE || "local").toLowerCase();

  try {
    const files =
      mode === "openai" ? await listOpenAI() : await listLocal();

    return NextResponse.json({
      mode,
      count: files.length,
      files,
    });
  } catch (err) {
    return NextResponse.json(
      {
        mode,
        error: true,
        message:
          err instanceof Error ? err.message : "Unexpected error listing KB files",
      },
      { status: 500 }
    );
  }
}