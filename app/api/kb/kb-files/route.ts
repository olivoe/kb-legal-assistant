import { promises as fs } from 'node:fs';
import path from 'node:path';

export const dynamic = 'force-dynamic';

export async function GET() {
  const kbDir = path.join(process.cwd(), 'kb');
  try {
    const entries = await fs.readdir(kbDir, { withFileTypes: true });
    const files = entries
      .filter(e => e.isFile())
      .map(e => e.name)
      .sort();
    const dirs = entries
      .filter(e => e.isDirectory())
      .map(e => e.name)
      .sort();
    return new Response(JSON.stringify({ ok: true, kbDir, filesCount: files.length, dirsCount: dirs.length, files, dirs }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, kbDir, error: e?.message || 'read failed' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
