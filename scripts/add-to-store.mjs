import 'dotenv/config';
import OpenAI from 'openai';
import fs from 'node:fs';
import path from 'node:path';

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || '' });
const storeId = process.env.OPENAI_VECTOR_STORE_ID || '';
if (!storeId) { console.error('Missing OPENAI_VECTOR_STORE_ID'); process.exit(1); }

const KB_DIR = path.resolve('kb');
const files = fs.readdirSync(KB_DIR)
  .filter(f => fs.statSync(path.join(KB_DIR, f)).isFile());

if (!files.length) { console.error('No files in kb/'); process.exit(1); }

for (const fname of files) {
  const fpath = path.join(KB_DIR, fname);
  console.log('Uploading:', fname);
  const uploaded = await client.files.create({
    file: fs.createReadStream(fpath),
    purpose: 'assistants',
  });
  console.log(' Attaching to store:', storeId);
  await client.vectorStores.files.create(storeId, { file_id: uploaded.id });
}
console.log('✅ Attached all kb/ files to', storeId);
