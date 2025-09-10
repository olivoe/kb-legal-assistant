"use client";

import { useEffect, useState } from "react";

type EvidenceItem = { filename: string; snippet: string };

type ChatReply = {
  answer: string;
  citations?: string[];
  evidence?: EvidenceItem[];
  error?: boolean;
  message?: string;
};

type Status = {
  mode: "openai" | "local";
  hasOpenAIKey: boolean;
  hasVectorStoreId: boolean;
  vectorStoreId: string | null;
};

export default function Home() {
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [history, setHistory] = useState<ChatReply[]>([]);
  const [status, setStatus] = useState<Status | null>(null);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);

  useEffect(() => {
    fetch("/api/status")
      .then((r) => r.json())
      .then((s: Status) => setStatus(s))
      .catch(() => setStatus(null));
  }, []);

  async function send() {
    const msg = input.trim();
    if (!msg || loading) return;
    setLoading(true);
    setInput("");

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: msg }),
      });
      const data = (await res.json()) as ChatReply;
      setHistory((h) => [
        {
          answer: data.answer,
          citations: data.citations || [],
          evidence: data.evidence || [],
        },
        ...h,
      ]);
    } catch {
      setHistory((h) => [{ answer: "Backend request failed.", citations: [] }, ...h]);
    } finally {
      setLoading(false);
    }
  }

  async function copyAnswer(text: string, idx: number) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedIdx(idx);
      setTimeout(() => setCopiedIdx(null), 1500);
    } catch {
      // silent fail
    }
  }

  const badge =
    status?.mode === "openai"
      ? `KB: OpenAI ${status?.vectorStoreId ? `(${status.vectorStoreId})` : ""}`
      : "KB: Local (disk)";

  return (
    <main className="min-h-screen max-w-3xl mx-auto p-6">
      <div className="flex items-start justify-between">
        <h1 className="text-2xl font-semibold mb-2">KB-first Legal Assistant (ES)</h1>
        <span
          title={status ? JSON.stringify(status) : "No status"}
          className={`text-xs px-2 py-1 rounded border ${
            status?.mode === "openai" ? "bg-green-50 border-green-200" : "bg-blue-50 border-blue-200"
          }`}
        >
          {status ? badge : "KB: …"}
        </span>
      </div>

      {/* Disclaimer */}
      <p className="text-xs text-gray-600 mb-4 border rounded px-3 py-2 bg-gray-50">
        Este asistente es solo informativo y no constituye asesoramiento legal.
        Consulta a un profesional calificado para obtener consejo específico sobre tu caso.
      </p>

      <div className="flex gap-2 mb-4">
        <input
          className="flex-1 border rounded px-3 py-2"
          placeholder="Type your question…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => (e.key === "Enter" ? send() : undefined)}
          disabled={loading}
        />
        <button className="border rounded px-4 py-2" onClick={send} disabled={loading}>
          {loading ? "Sending…" : "Send"}
        </button>
      </div>

      <ul className="space-y-4">
        {history.map((r, idx) => (
          <li key={idx} className="border rounded p-4">
            <div className="flex items-start justify-between gap-2">
              <p className="whitespace-pre-wrap flex-1">{r.answer}</p>
              <button
                onClick={() => copyAnswer(r.answer, idx)}
                className="text-xs whitespace-nowrap border rounded px-2 py-1 bg-white hover:bg-gray-50"
                aria-label="Copy answer"
                title="Copy answer"
              >
                {copiedIdx === idx ? "Copied!" : "Copy"}
              </button>
            </div>

            {!!(r.citations && r.citations.length) && (
              <div className="mt-3 text-sm">
                <span className="font-medium">Citations:</span>
                <div className="mt-2 flex flex-wrap gap-2">
                  {r.citations.map((c, i) => (
                    <span
                      key={`${c}-${i}`}
                      className="inline-block bg-gray-100 border rounded px-2 py-0.5"
                    >
                      {c}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {!!(r.evidence && r.evidence.length) && (
              <details className="mt-3">
                <summary className="cursor-pointer select-none text-sm font-medium">
                  Show evidence
                </summary>
                <div className="mt-2 space-y-3">
                  {r.evidence.map((ev, i) => (
                    <div key={`${ev.filename}-${i}`} className="text-sm">
                      <div className="font-medium">{ev.filename}</div>
                      <div className="mt-1 whitespace-pre-wrap bg-gray-50 border rounded p-2">
                        {ev.snippet}
                      </div>
                    </div>
                  ))}
                </div>
              </details>
            )}
          </li>
        ))}
      </ul>
    </main>
  );
}