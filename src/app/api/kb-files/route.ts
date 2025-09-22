/* eslint-disable @typescript-eslint/no-explicit-any */

import { NextRequest } from "next/server";
import path from "node:path";
import { fileListForKey } from "@/lib/kb-utils"; // ✅ shared recursive utility

const LOCAL_KB_DIR = process.env.KB_DIR || "./data/kb";

export async function GET(req: NextRequest) {
  try {
    const files = fileListForKey(LOCAL_KB_DIR);
    return Response.json({
      kbDir: path.resolve(LOCAL_KB_DIR),
      count: files.length,
      files, // already relative paths
    });
  } catch (err: any) {
    return Response.json(
      { error: true, message: err?.message || "Failed to read KB" },
      { status: 500 }
    );
  }
}