import 'dotenv/config';
import OpenAI from 'openai';
import fs from 'node:fs';
import path from 'node:path';

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || '' });

const KB_DIR = path.resolve('kb');
if (!fs.existsSync(KB_DIR)) {
  console.error('kb directory not found:', KB_DIR);
  process.exit(1);
}

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    console.error('Missing OPENAI_API_KEY'); process.exit(1);
  }

  const storeName = 'kb-legal-assistant-store';
  console.log('Creating vector store:', storeName);
  const store = await client.vectorStores.create({ name: storeName });
  console.log('Vector store id:', store.id);

  const files = fs.readdirSync(KB_DIR).filter(f =>
    fs.statSync(path.join(KB_DIR, f)).isFile()
  );

  if (files.length === 0) {
    console.error('No files found in kb/'); process.exit(1);
  }

  for (const fname of files) {
    const fpath = path.join(KB_DIR, fname);
    console.log('Uploading file:', fname);

    const uploaded = await client.files.create({
      file: fs.createReadStream(fpath),
      purpose: 'assistants',
    });

    console.log(' Attaching to vector store...');
    // IMPORTANT: path param first, then body
    await client.vectorStores.files.create(store.id, {
      file_id: uploaded.id,
    });
  }

  console.log('\n✅ Done.');
  console.log('VECTOR_STORE_ID=', store.id);
}

main().catch(err => {
  console.error('Failed:', err.status || '', err.message || err);
  process.exit(1);
});
