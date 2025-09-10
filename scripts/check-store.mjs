import 'dotenv/config';
import OpenAI from 'openai';

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || '' });
const id = process.env.OPENAI_VECTOR_STORE_ID || '';
if (!id) { console.error('Missing OPENAI_VECTOR_STORE_ID'); process.exit(1); }

const list = await client.vectorStores.files.list(id, { limit: 100 });
console.log('Vector store:', id);
for (const f of list.data) {
  let name = 'unknown';
  try {
    const meta = await client.files.retrieve(f.id);
    name = meta.filename || meta.id;
  } catch {}
  console.log(`- ${name}  file_id=${f.id}  status=${f.status}  last_error=${f.last_error?.message || 'none'}`);
}
