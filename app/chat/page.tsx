"use client";

import { useCallback, useRef, useState } from "react";

type TopK = { id: string; file: string; score: number; start: number; end: number };

export default function ChatPage() {
  const [q, setQ] = useState("");
  const [answer, setAnswer] = useState("");
  const [allowed, setAllowed] = useState<string[]>([]);
  const [topk, setTopk] = useState<TopK[]>([]);
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const ask = useCallback(async () => {
    if (!q.trim() || busy) return;
    setBusy(true);
    setAnswer("");
    setAllowed([]);
    setTopk([]);

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    // 1) Streamed answer
    try {
      const res = await fetch(`/api/chat?stream=1&limit=5`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: q }] }),
        signal: ctrl.signal,
      });

      if (!res.ok || !res.body) throw new Error("no stream body");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();

      let buf = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        let idx: number;
        // parse SSE "data: {...}\n\n"
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const line = chunk.trim();
          if (!line.startsWith("data:")) continue;
          const jsonStr = line.slice(5).trim();
          if (jsonStr === "[DONE]") continue;
          try {
            const json = JSON.parse(jsonStr);
            const delta = json?.choices?.[0]?.delta?.content ?? "";
            if (delta) setAnswer((prev) => prev + delta);
          } catch {
            // ignore parse errors on partials
          }
        }
      }
    } catch (e) {
      // fallback to non-stream JSON single call
      try {
        const res = await fetch(`/api/chat?limit=5`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: [{ role: "user", content: q }] }),
          signal: ctrl.signal,
        });
        const json = await res.json();
        const maybe = String(json?.answer || "");
        setAnswer(maybe || "No consta en el contexto.");
      } catch {
        setAnswer("Error de red.");
      }
    }

    // 2) Always fetch metadata (topk & allowed) with a quick non-stream call
    try {
      const res = await fetch(`/api/chat?limit=5`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: q }] }),
        signal: ctrl.signal,
      });
      const json = await res.json();
      setAllowed(Array.isArray(json?.allowedFiles) ? json.allowedFiles : []);
      setTopk(Array.isArray(json?.topk) ? json.topk : []);
    } catch {
      // ignore
    }

    setBusy(false);
  }, [q, busy]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    setBusy(false);
  }, []);

  return (
    <main className="max-w-2xl mx-auto p-6 space-y-6">
      <h1 className="text-2xl font-semibold">KB Legal Assistant</h1>

      <div className="flex gap-2">
        <input
          className="flex-1 border rounded px-3 py-2"
          placeholder="Escribe tu pregunta…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") ask(); }}
          disabled={busy}
        />
        {!busy ? (
          <button className="border rounded px-4 py-2" onClick={ask}>Preguntar</button>
        ) : (
          <button className="border rounded px-4 py-2" onClick={stop}>Detener</button>
        )}
      </div>

      <section className="space-y-2">
        <h2 className="text-lg font-medium">Respuesta</h2>
        <div className="whitespace-pre-wrap border rounded p-3 min-h-[4rem]">
          {answer || "—"}
        </div>
      </section>

      <section className="space-y-2">
        <h3 className="text-base font-medium">Archivos permitidos</h3>
        <div className="text-sm">{allowed.length ? allowed.join(", ") : "—"}</div>
      </section>

      <section className="space-y-2">
        <h3 className="text-base font-medium">Fragmentos relevantes (top-k)</h3>
        <ul className="text-sm space-y-2">
          {topk.map((t) => (
            <li key={t.id} className="border rounded p-2">
              <div><b>file:</b> {t.file}</div>
              <div><b>score:</b> {t.score}</div>
              <div><b>range:</b> {t.start}–{t.end}</div>
            </li>
          ))}
          {!topk.length && <li>—</li>}
        </ul>
      </section>
    </main>
  );
}