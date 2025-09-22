/* eslint-disable @typescript-eslint/no-explicit-any */

import { NextRequest } from "next/server";
import fs from "node:fs";
import path from "node:path";

const LOCAL_KB_DIR = process.env.KB_DIR || "./data/kb";

/** Recursively collect file paths in KB */
function walkDir(dir: string, fileList: string[] = []): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      walkDir(full, fileList);
    } else if (/\.(txt|md|markdown|pdf|docx|html?|htm)$/i.test(e.name)) {
      fileList.push(full);
    }
  }
  return fileList;
}

export async function GET(req: NextRequest) {
  try {
    const files = walkDir(LOCAL_KB_DIR);
    return Response.json({
      kbDir: path.resolve(LOCAL_KB_DIR),
      count: files.length,
      files: files.map((f) => path.relative(LOCAL_KB_DIR, f)),
      refreshedAt: new Date().toISOString(),
    });
  } catch (err: any) {
    return Response.json(
      { error: true, message: err?.message || "Failed to refresh KB" },
      { status: 500 }
    );
  }
}