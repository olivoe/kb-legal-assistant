import 'dotenv/config';
import OpenAI from 'openai';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || '' });
const storeId = process.env.OPENAI_VECTOR_STORE_ID || '';
if (!storeId) { console.error('Missing OPENAI_VECTOR_STORE_ID'); process.exit(1); }

const ROOT = path.resolve('kb');
const ALLOWED = new Set(['.pdf', '.txt', '.md', '.docx', '.rtf', '.html']);

function* walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}

async function listExistingFilenames() {
  const names = new Set();
  let next = undefined;
  do {
    const page = await client.vectorStores.files.list(storeId, { limit: 100, page: next });
    for (const vf of page.data) {
      try {
        const meta = await client.files.retrieve(vf.file_id || vf.id);
        if (meta?.filename) names.add(meta.filename);
      } catch { /* ignore */ }
    }
    next = page?.next_page;
  } while (next);
  return names;
}

async function main() {
  if (!fs.existsSync(ROOT)) {
    console.error('kb folder not found at', ROOT);
    process.exit(1);
  }

  const existing = await listExistingFilenames();
  const localFiles = Array.from(walk(ROOT))
    .filter(p => ALLOWED.has(path.extname(p).toLowerCase()));

  let uploaded = 0, skipped = 0, errors = 0;

  for (const fpath of localFiles) {
    const fname = path.basename(fpath);
    if (existing.has(fname)) {
      console.log('Skip (already in store):', fname);
      skipped++;
      continue;
    }
    try {
      console.log('Uploading:', fname);
      const file = await client.files.create({
        file: fs.createReadStream(fpath),
        purpose: 'assistants',
      });
      console.log(' Attaching to store…');
      await client.vectorStores.files.create(storeId, { file_id: file.id });
      uploaded++;
    } catch (e) {
      console.error(' Failed:', fname, '-', e?.message || e);
      errors++;
    }
  }

  console.log('\n✅ Sync finished.');
  console.log('Uploaded:', uploaded, '| Skipped:', skipped, '| Errors:', errors);
}

main().catch(err => {
  console.error('Sync failed:', err?.message || err);
  process.exit(1);
});
