import fs from 'node:fs';
const mod = await import('pdf-parse');
const pdf = mod.default || mod;

const path = 'data/kb/ley_pdf.pdf';   // adjust if your filename differs
const buf = fs.readFileSync(path);
const { text } = await pdf(buf);

console.log('Chars:', text.length);
console.log('First 300 chars:\n', text.slice(0, 300));
