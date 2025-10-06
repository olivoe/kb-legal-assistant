// app/api/rag/answer/route.ts
import { roeFinalize, setDisclaimerCookieHeader } from "@/lib/roe/finalizer";

const ROE_FINALIZER_ENABLED = process.env.ROE_FINALIZER_ENABLED === "on";
const MIN_CONFIDENCE = Number(process.env.MIN_CONFIDENCE ?? 0.55);

// POST /api/rag/answer
export async function POST(req: Request) {
  // --- Deterministic JSON test mode (?test=1) ---
  const url = new URL(req.url);
  if (url.searchParams.get("test") === "1") {
    return new Response(
      JSON.stringify({
        ok: true,
        mode: "test",
        answer: "Este es un mensaje de prueba determinístico.",
        citations: [],
        disclaimerInjected: false,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }
  // --- End test mode ---

  // --- Your existing logic should run here ---
  // Parse body, retrieve from KB, optionally web fallback, call LLM, etc.
  // It should ultimately produce:
  //   const spanishAnswer: string = "...";
  //   const confidence: number = 0.0..1.0;
  //   const citations: any[] = [...];

  // ⬇️ Replace the following three placeholder lines with your real values.
  // They are here only so this file compiles if pasted directly.
  // ---------------------------------------------------------------------------------
  // @ts-expect-error - replace with real answer text
  const spanishAnswer: string = spanishAnswer ?? "";
  // @ts-expect-error - replace with real confidence score (0..1)
  const confidence: number = confidence ?? 0;
  // @ts-expect-error - replace with real citations array
  const citations: any[] = citations ?? [];
  // ---------------------------------------------------------------------------------

  // --- RoE Finalizer application ---
  const injectDisclaimer = true; // RoE: one-time per session
  const disclaimerAlreadyShown =
    (req.headers.get("cookie") ?? "").includes("roe_disclaimer_shown=1");

  let text = spanishAnswer;
  let disclaimerInjected = false;

  if (ROE_FINALIZER_ENABLED) {
    const out = roeFinalize(spanishAnswer, {
      injectDisclaimer,
      disclaimerAlreadyShown,
      uncertainty: confidence < MIN_CONFIDENCE,
      maxSentences: 6,
    });
    text = out.text;
    disclaimerInjected = out.disclaimerInjected;
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (disclaimerInjected) {
    Object.assign(headers, setDisclaimerCookieHeader());
  }

  return new Response(
    JSON.stringify({ ok: true, answer: text, citations, disclaimerInjected, confidence }),
    { status: 200, headers }
  );
}