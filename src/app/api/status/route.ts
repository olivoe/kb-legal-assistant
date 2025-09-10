export const runtime = "nodejs";

import { NextRequest } from "next/server";

export async function GET(_req: NextRequest) {
  const mode = (
    process.env.KB_MODE ||
    (process.env.VERCEL_ENV === "production" ? "openai" : "local")
  ).toLowerCase();
  const storeId = process.env.OPENAI_VECTOR_STORE_ID || "";
  const hasKey = Boolean(process.env.OPENAI_API_KEY);

  return Response.json({
    mode,                       // "openai" | "local"
    hasOpenAIKey: hasKey,
    hasVectorStoreId: !!storeId,
    vectorStoreId: storeId ? `${storeId.slice(0, 7)}…${storeId.slice(-5)}` : null,
  });
}