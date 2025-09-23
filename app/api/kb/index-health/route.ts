import { promises as fs } from "node:fs";
import path from "node:path";

export const dynamic = "force-dynamic";

export async function GET() {
  const kbDir = path.join(process.cwd(), "kb");
  const indexPath = path.join(process.cwd(), "data", "kb", "kb_index.json");

  // load dir listing
  const entries = await fs.readdir(kbDir, { withFileTypes: true });
  const diskFiles = entries.filter(e => e.isFile()).map(e => e.name).sort();

  // load index (supports array or {files:[...]} or map)
  let raw = "";
  try { raw = await fs.readFile(indexPath, "utf8"); } catch { /* no index yet */ }
  let indexed: string[] = [];
  if (raw) {
    try {
      const json = JSON.parse(raw);
      if (Array.isArray(json)) indexed = json;
      else if (Array.isArray(json?.files)) indexed = json.files;
      else if (json && typeof json === "object") indexed = Object.keys(json);
    } catch (e: any) {
      return new Response(JSON.stringify({ ok:false, error: "index-parse-failed", message: e?.message }), { status: 200, headers: { "Content-Type": "application/json" }});
    }
  }

  indexed = indexed.map(String).sort();

  // diffs
  const setDisk = new Set(diskFiles);
  const setIdx  = new Set(indexed);
  const orphans = diskFiles.filter(f => !setIdx.has(f));     // on disk but not in index
  const missing = indexed.filter(f => !setDisk.has(f));      // in index but not on disk

  return new Response(JSON.stringify({
    ok: true,
    kbDir, indexPath,
    diskCount: diskFiles.length,
    indexCount: indexed.length,
    orphansCount: orphans.length,
    missingCount: missing.length,
    orphans: orphans.slice(0, 100),
    missing: missing.slice(0, 100),
  }), { status: 200, headers: { "Content-Type": "application/json" }});
}
