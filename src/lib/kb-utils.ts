/* eslint-disable @typescript-eslint/no-explicit-any */

import fs from "node:fs";
import path from "node:path";

/**
 * Recursively collect all files (with allowed extensions) from dir and subdirs.
 * Paths are stored relative to the base dir.
 */
export function fileListForKey(dir: string): string[] {
  const out: string[] = [];

  function walk(currentDir: string) {
    try {
      const entries = fs.readdirSync(currentDir, { withFileTypes: true });
      for (const e of entries) {
        const full = path.join(currentDir, e.name);
        if (e.isDirectory()) {
          walk(full);
        } else if (/\.(txt|md|markdown|pdf|docx|html?|htm)$/i.test(e.name)) {
          out.push(path.relative(dir, full));
        }
      }
    } catch {}
  }

  walk(dir);
  return out.sort();
}