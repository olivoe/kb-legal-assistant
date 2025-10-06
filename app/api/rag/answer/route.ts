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

  // ...existing logic continues...
}