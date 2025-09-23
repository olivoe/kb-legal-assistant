export const dynamic = 'force-dynamic';

export async function GET() {
  return new Response('kb status alive', {
    status: 200,
    headers: { 'Content-Type': 'text/plain' },
  });
}
