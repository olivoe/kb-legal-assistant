export const runtime = "nodejs";

import { NextRequest } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || "" });
const STORE_ID = process.env.OPENAI_VECTOR_STORE_ID || "";
const KB_MODE = (process.env.KB_MODE || "local").toLowerCase(); // "local" | "openai"

// ---------- helpers ----------
function normalize(s: string) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");
}

async function loadLocalKB(dir = "kb") {
  const base = path.resolve(dir);
  let files: string[] = [];
  try {
    const entries = await fs.readdir(base);
    files = entries
      .filter((f) => /\.(txt|md)$/i.test(f))
      .map((f) => path.join(base, f));
  } catch {
    // no kb folder
  }
  const docs: Array<{ filename: string; text: string }> = [];
  for (const f of files) {
    try {
      const text = await fs.readFile(f, "utf8");
      docs.push({ filename: path.basename(f), text });
    } catch {}
  }
  return docs;
}

type Hit = { filename: string; snippet: string };

function findMatches(q: string, docs: Array<{ filename: string; text: string }>): Hit[] {
  const qNorm = normalize(q).replace(/[“”"']/g, "");
  const numTokens = qNorm.match(/\b\d+\b/g) ?? [];
  const wordTokens = Array.from(new Set(qNorm.split(/[^a-z0-9áéíóúñü]+/i))).filter((w) => w.length >= 5);

  const phrases = [
    "articulo 123 del codigo procesal",
    "articulo 123 codigo procesal",
    "123 del codigo procesal",
  ];

  const hits: Hit[] = [];

  for (const { filename, text } of docs) {
    const textNorm = normalize(text);

    let matched = phrases.some((p) => textNorm.includes(p));
    if (!matched) {
      const wordHits = wordTokens.filter((w) => textNorm.includes(w));
      const numHits = numTokens.filter((n) => textNorm.includes(n));
      matched = numHits.length >= 1 || wordHits.length >= 2;
    }

    if (matched) {
      const anchor =
        (numTokens.find((n) => textNorm.includes(n)) ??
          wordTokens.find((w) => textNorm.includes(w)) ??
          phrases.find((p) => textNorm.includes(p)) ??
          "");
      const idx = anchor ? textNorm.indexOf(anchor) : 0;
      const start = Math.max(0, idx - 160);
      const end = Math.min(text.length, idx + (anchor?.length || 0) + 160);
      const snippet = text.slice(start, end).replace(/\s+/g, " ");
      hits.push({ filename, snippet });
    }
  }
  return hits;
}

// ---------- main handler ----------
export async function POST(req: NextRequest) {
  try {
    const { message } = await req.json();
    const q = String(message ?? "").trim();
    if (!q) {
      return Response.json({ answer: "No hay información suficiente en la base.", citations: [] });
    }

    let docs: Array<{ filename: string; text: string }> = [];

    if (KB_MODE === "openai") {
      // 1) Try OpenAI vector search (stable, server-side)
      if (!process.env.OPENAI_API_KEY || !STORE_ID) {
        return Response.json({ answer: "No hay información suficiente en la base.", citations: [] });
      }

      // Call vector search API
      let results: any[] = [];
      try {
        const res = await client.vectorStores.search(STORE_ID, { query: q });
        results = res.data ?? [];
      } catch (e) {
        // ignore and fall back
        results = [];
      }

      // Turn search results into minimal docs set (filename + text snippet)
      const primaryDocs: Array<{ filename: string; text: string }> = (results || []).map((r: any) => ({
        filename: r.filename || "desconocido",
        text: r.content?.[0]?.text || "",
      }));

      docs = primaryDocs.filter((d) => d.text);

      // 2) Fallback: if search returned nothing, read full files from the store and match locally
      if (!docs.length) {
        const list = await client.vectorStores.files.list(STORE_ID, { limit: 100 });
        for (const vf of (list.data ?? []) as any[]) {
          const fileId = vf.file_id || vf.id;
          try {
            const meta = await client.files.retrieve(fileId);
            const name = meta?.filename || fileId;
            const resp = await client.files.content(fileId);
            const text = (await resp.text()).slice(0, 1_500_000);
            if (text) docs.push({ filename: name, text });
          } catch {
            // skip
          }
        }
      }
    } else {
      // DEV mode: read from local disk
      docs = await loadLocalKB("kb");
    }

    if (!docs.length) {
      return Response.json({ answer: "No hay información suficiente en la base.", citations: [] });
    }

    const hits = findMatches(q, docs);
    if (!hits.length) {
      return Response.json({ answer: "No hay información suficiente en la base.", citations: [] });
    }

    const top = hits.slice(0, 3);
    const citations = top.map((h) => h.filename);
    const answer = `Se encontró la información en: ${citations.join(", ")}. Ejemplo: ${top[0].snippet.slice(0, 220)}…`;

    return Response.json({ answer, citations });
  } catch (err: any) {
    console.error("API error:", err?.status, err?.message || err);
    return Response.json({ error: true, message: err?.message || "API failed" }, { status: 500 });
  }
}