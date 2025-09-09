import { NextRequest } from "next/server";

export async function POST(req: NextRequest) {
  const { message } = await req.json();
  return Response.json({
    answer: `✅ Stub OK. Recibí: “${message}”. Conectaremos OpenAI y tu KB en el siguiente paso.`,
  });
}
