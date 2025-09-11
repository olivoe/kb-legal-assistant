export const runtime = "nodejs";

import { NextRequest } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import OpenAI from "openai";

type FileRow = {
  filename: string;
  sizeBytes?: number | null;
  modifiedAt?: string | null;
  file_id?: string | null; // for OpenAI store
  preview?: string | null; // optional
};

const KB_MODE = (
  process.env.KB_MODE ||
  (process.env.VERCEL_ENV === "production" ? "openai" : "local")
).toLowerCase(); // "local" | "openai"

const STORE_ID = process.env.OPENAI_VECTOR_STORE_ID || "";
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || "" });

async function listLocal(previewChars: number): Promise<FileRow[]> {
  const dir = path.resolve("kb");
  let names: string[] = [];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }

  const filtered = names.filter((n) => /\.(txt|md)$/i.test(n));
  const out: FileRow[] = [];

  for (const name of filtered) {
    const p = path.join(dir, name);
    try {
      const st = await fs.stat(p);
      let preview: string | null = null;
      if (previewChars > 0 && st.size > 0) {
        // Read only up to previewChars
        const text = await fs.readFile(p, "utf8");
        preview = text.slice(0, previewChars);
      }
      out.push({
        filename: name,
        sizeBytes: st.size,
        modifiedAt: st.mtime.toISOString(),
        file_id: null,
        preview,
      });
    } catch {
      // skip unreadable
    }
  }
  return out;
}

async function listOpenAI(previewChars: number): Promise<FileRow[]> {
  if (!STORE_ID || !process.env.OPENAI_API_KEY) return [];

  // List up to 100 files; adjust if you expect more
  let items: Array<{ id: string; file_id?: string }> = [];
  try {
    const listed = (await client.vectorStores.files.list(STORE_ID, { limit: 100 })) as unknown as {
      data?: Array<{ id: string; file_id?: string }>;
    };
    items = listed.data ?? [];
  } catch {
    items = [];
  }

  const out: FileRow[] = [];
  for (const it of items) {
    const fileId = it.file_id ?? it.id;
    try {
      // Get filename, size
      const meta = (await client.files.retrieve(fileId)) as unknown as {
        filename?: string;
        bytes?: number;
      };
      const filename = meta.filename ?? fileId;
      const sizeBytes = typeof meta.bytes === "number" ? meta.bytes : null;

      // Optional preview (may be large; read cautiously)
      let preview: string | null = null;
      if (previewChars > 0) {
        try {
          const contentResp = await client.files.content(fileId);
          const txt = await contentResp.text();
          preview = txt.slice(0, previewChars);
        } catch {
          preview = null; // could be binary
        }
      }

      out.push({
        filename,
        sizeBytes,
        modifiedAt: null,
        file_id: fileId,
        preview,
      });
    } catch {
      // skip unreadable/binary
    }
  }
  return out;
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  // ?preview=300 -> include first 300 chars; default 0 (no preview)
  const previewParam = url.searchParams.get("preview");
  const preview = Math.max(0, Math.min(2000, Number(previewParam || 0) || 0));

  const effectiveMode = KB_MODE; // already env-driven

  let rows: FileRow[] = [];
  if (effectiveMode === "openai") {
    rows = await listOpenAI(preview);
  } else {
    rows = await listLocal(preview);
  }

  // Also include a simple count and mode so you can sanity-check quickly
  return Response.json({
    mode: effectiveMode,
    count: rows.length,
    files: rows,
  });
}