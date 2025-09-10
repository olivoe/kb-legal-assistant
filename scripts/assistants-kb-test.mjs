import 'dotenv/config';
import OpenAI from 'openai';

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || '' });
const storeId = process.env.OPENAI_VECTOR_STORE_ID || '';
if (!storeId) { console.error('Missing OPENAI_VECTOR_STORE_ID'); process.exit(1); }

const INSTRUCTIONS = `
Eres un asistente legal en español. Usa EXCLUSIVAMENTE la información recuperada de File Search.
Si no hay evidencia suficiente, responde exactamente: "No hay información suficiente en la base."
Incluye al final una lista de citas con nombres de archivo cuando existan.
`;

async function main() {
  // 1) Assistant with File Search pointed at YOUR store
  const assistant = await client.beta.assistants.create({
    name: 'KB Sanity Test',
    model: 'gpt-4o',
    instructions: INSTRUCTIONS,
    tools: [{ type: 'file_search' }],
    tool_resources: { file_search: { vector_store_ids: [storeId] } },
  });

  // 2) Thread with your test question
  const thread = await client.beta.threads.create({
    messages: [{
      role: 'user',
      content: '¿Qué documento menciona el "artículo 123 del Código Procesal" y qué dice?',
    }],
  });

  // 3) Run + poll
  let run = await client.beta.threads.runs.create({
    thread_id: thread.id,
    assistant_id: assistant.id,
  });

  const terminal = new Set(['completed','failed','cancelled','expired']);
  while (!terminal.has(run.status)) {
    await new Promise(r => setTimeout(r, 900));
    run = await client.beta.threads.runs.retrieve({
      thread_id: thread.id,
      run_id: run.id,
    });
  }

  // 4) Read latest messages (✅ single params object)
  const msgs = await client.beta.threads.messages.list({
    thread_id: thread.id,
    order: 'desc',
    limit: 5,
  });

  const top = msgs.data?.[0];
  const parts = top?.content || [];
  const text = parts.map(p => (p.type === 'text' ? p.text.value : '')).join('\n').trim();
  console.log('--- Assistant reply ---\n' + (text || '(empty)'));

  // 5) Show run steps (✅ single params object)
  const steps = await client.beta.threads.runs.steps.list({
    thread_id: thread.id,
    run_id: run.id,
    order: 'desc',
    limit: 20,
  });

  console.log('\n--- Run steps ---');
  for (const s of steps.data) {
    console.log(`- type=${s.type} status=${s.status}`);
    if (s.type === 'tool_calls' && s.step_details?.tool_calls) {
      for (const tc of s.step_details.tool_calls) {
        console.log(`  • tool=${tc.type}`);
      }
    }
  }
}

main().catch(err => {
  console.error('Error:', err.status || '', err.message || err);
  process.exit(1);
});
