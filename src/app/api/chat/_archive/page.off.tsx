"use client";

import { useRef, useState } from "react";
import { streamChat, type ChatTurn, type ChatOpts } from "@/lib/sseClient";

type JsonResult = {
  answer: string;
  citations: string[];
  evidence: { filename: string; snippet: string; score?: number }[];
};

export default function ChatPage() {
  const [history, setHistory] = useState<ChatTurn[]>([]);
  const [message, setMessage] = useState(
    "¿Qué dice el artículo 123 del Código Procesal?"
  );
  const [answer, setAnswer] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [nocache, setNocache] = useState(false);

  // RAG override controls
  const [hybrid, setHybrid] = useState(true);
  const [overfetch, setOverfetch] = useState<number>(9);
  const [rrfK, setRrfK] = useState<number>(60);
  const [scoreMin, setScoreMin] = useState<number>(0.28);
  const [maxHits, setMaxHits] = useState<number>(3);

  // Debug headers + evidence after stream completes
  const [hdr, setHdr] = useState<Record<string, string>>({});
  const [citations, setCitations] = useState<string[]>([]);
  const [evidence, setEvidence] = useState<JsonResult["evidence"]>([]);
  const abortRef = useRef<AbortController | null>(null);

  const opts: ChatOpts = {
    hybrid,
    overfetch,
    rrf_k: rrfK,
    score_min: scoreMin,
    max_hits: maxHits,
  };

  const send = async () => {
    if (streaming || !message.trim()) return;
    setStreaming(true);
    setAnswer("");
    setCitations([]);
    setEvidence([]);
    setHdr({});
    abortRef.current = new AbortController();

    const newHistory: ChatTurn[] = [
      ...history,
      { role: "user", content: message.trim() },
    ];

    try {
      await streamChat({
        message: message.trim(),
        history: newHistory,
        nocache,
        opts, // <-- per-request overrides
        onHeaders: (h) => setHdr(h),
        onDelta: (d) => setAnswer((p) => p + d),
        onDone: async () => {
          setStreaming(false);
          setHistory((h) => [
            ...h,
            { role: "user", content: message.trim() },
            { role: "assistant", content: answer || "(vacío)" },
          ]);

          // Pull the cached JSON (HIT) to show citations/evidence
          try {
            const res = await fetch("/api/chat", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                message: message.trim(),
                history: newHistory,
                // same overrides ensure same cache key
                opts,
              }),
            });
            const j = (await res.json()) as JsonResult;
            setCitations(j.citations || []);
            setEvidence(j.evidence || []);
          } catch {
            /* ignore */
          }
        },
        signal: abortRef.current.signal,
      });
    } catch (err) {
      setStreaming(false);
      console.error(err);
    }
  };

  const cancel = () => {
    abortRef.current?.abort();
    setStreaming(false);
  };

  return (
    <div style={{ maxWidth: 960, margin: "2rem auto", padding: "0 1rem" }}>
      <h1 style={{ fontSize: 26, fontWeight: 800, marginBottom: 12 }}>
        Legal Assistant — Chat (Hybrid RAG)
      </h1>

      {/* Controls */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr 1fr 1fr 1fr",
          gap: 12,
          marginBottom: 12,
        }}
      >
        <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input
            type="checkbox"
            checked={nocache}
            onChange={(e) => setNocache(e.target.checked)}
          />
          nocache
        </label>

        <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input
            type="checkbox"
            checked={hybrid}
            onChange={(e) => setHybrid(e.target.checked)}
          />
          hybrid (RRF)
        </label>

        <label>
          overfetch
          <input
            type="number"
            min={1}
            value={overfetch}
            onChange={(e) => setOverfetch(Number(e.target.value))}
            style={{ width: "100%", padding: 6, border: "1px solid #ddd", borderRadius: 6 }}
          />
        </label>

        <label>
          rrf_k
          <input
            type="number"
            min={1}
            value={rrfK}
            onChange={(e) => setRrfK(Number(e.target.value))}
            style={{ width: "100%", padding: 6, border: "1px solid #ddd", borderRadius: 6 }}
          />
        </label>

        <label>
          score_min
          <input
            type="number"
            step="0.01"
            value={scoreMin}
            onChange={(e) => setScoreMin(Number(e.target.value))}
            style={{ width: "100%", padding: 6, border: "1px solid #ddd", borderRadius: 6 }}
          />
        </label>

        <label>
          max_hits
          <input
            type="number"
            min={1}
            value={maxHits}
            onChange={(e) => setMaxHits(Number(e.target.value))}
            style={{ width: "100%", padding: 6, border: "1px solid #ddd", borderRadius: 6 }}
          />
        </label>
      </div>

      {/* Prompt box */}
      <textarea
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        rows={3}
        placeholder="Pregunta…"
        style={{ width: "100%", padding: 10, border: "1px solid #ddd", borderRadius: 6 }}
      />

      <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
        <button
          onClick={send}
          disabled={streaming}
          style={{
            padding: "8px 14px",
            borderRadius: 6,
            border: "1px solid #111",
            background: streaming ? "#eee" : "#111",
            color: streaming ? "#111" : "#fff",
            cursor: streaming ? "not-allowed" : "pointer",
          }}
        >
          {streaming ? "Streaming…" : "Send"}
        </button>
        {streaming && (
          <button
            onClick={cancel}
            style={{
              padding: "8px 14px",
              borderRadius: 6,
              border: "1px solid #b91c1c",
              background: "#fff",
              color: "#b91c1c",
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
        )}
      </div>

      {/* Answer */}
      <div style={{ marginTop: 18 }}>
        <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>Answer</h2>
        <div
          style={{
            whiteSpace: "pre-wrap",
            border: "1px solid #ddd",
            borderRadius: 6,
            padding: 12,
            minHeight: 100,
            background: "#fafafa",
          }}
        >
          {answer || "—"}
        </div>
      </div>

      {/* Citations/Evidence (from cached JSON) */}
      <div style={{ marginTop: 18 }}>
        <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>Evidence</h2>
        {evidence.length ? (
          <ul style={{ paddingLeft: 16, margin: 0 }}>
            {evidence.map((evi, i) => (
              <li key={i} style={{ marginBottom: 8 }}>
                <strong>{evi.filename}</strong>
                {typeof evi.score === "number" ? ` (score ${evi.score.toFixed(3)})` : ""}:{" "}
                <span>{evi.snippet}</span>
              </li>
            ))}
          </ul>
        ) : (
          <div style={{ border: "1px solid #eee", borderRadius: 6, padding: 12, background: "#fff" }}>
            —
          </div>
        )}
      </div>

      {/* Response headers */}
      <div style={{ marginTop: 18 }}>
        <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 6 }}>Response headers</h2>
        <div
          style={{
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
            fontSize: 13,
            border: "1px solid #eee",
            borderRadius: 6,
            padding: 12,
            background: "#fff",
          }}
        >
          {Object.keys(hdr).length ? (
            <ul style={{ paddingLeft: 16, margin: 0 }}>
              {Object.entries(hdr).map(([k, v]) => (
                <li key={k}>
                  <strong>{k}</strong>: {v}
                </li>
              ))}
            </ul>
          ) : (
            "—"
          )}
        </div>
      </div>
    </div>
  );
}