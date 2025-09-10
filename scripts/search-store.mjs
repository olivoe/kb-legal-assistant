import 'dotenv/config';
import OpenAI from 'openai';

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || '' });
const storeId = process.env.OPENAI_VECTOR_STORE_ID || '';
if (!storeId) { console.error('Missing OPENAI_VECTOR_STORE_ID'); process.exit(1); }

const query = process.argv.slice(2).join(' ') || 'artículo 123 del Código Procesal';

// ✅ Pass the store ID as the first positional arg
const res = await client.vectorStores.search(storeId, {
  query
});

console.log('Query:', query);
if (!res.data?.length) {
  console.log('(no results)');
} else {
  for (const r of res.data) {
    const snippet = r.content?.[0]?.text?.slice(0, 160)?.replace(/\s+/g, ' ') ?? '';
    console.log(`- filename=${r.filename} score=${r.score ?? ''} "${snippet}"`);
  }
}