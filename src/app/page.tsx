"use client";

import { useEffect, useState } from "react";

type EvidenceItem = { filename: string; snippet: string };
type Role = "user" | "assistant";

type ChatMessage = {
  role: Role;
  content: string;
  citations?: string[];
  evidence?: EvidenceItem[];
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
  const [status, setStatus] = useState<Status | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
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
    setInput("");

    const newUser: ChatMessage = { role: "user", content: msg };
    setMessages((m) => [...m, newUser]);
    setLoading(true);

    try {
      // Send compact recent history (last 8 messages) to the backend
      const compact = messages
        .slice(-8)
        .map(({ role, content }) => ({ role, content }));

      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: msg, history: compact }),
      });

      const data = (await res.json()) as {
        answer?: string;
        citations?: string[];
        evidence?: EvidenceItem[];
        error?: boolean;
        message?: string;
      };

      const content =
        data?.answer ??
        data?.message ??
        "No hay información suficiente en la base.";

      const newAssistant: ChatMessage = {
        role: "assistant",
        content,
        citations: data.citations || [],
        evidence: data.evidence || [],
      };

      setMessages((m) => [...m, newAssistant]);
    } catch {
      setMessages((m) => [
        ...m,
        {
          role: "assistant",
          content: "Backend request failed.",
        },
      ]);
    } finally {
      setLoading(false);
    }
  }

  async function copyAnswer(text: string, idx: number) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedIdx(idx);
      setTimeout(() => setCopiedIdx(null), 1500);
    } catch {/* noop */}
  }

  const badge =
    status?.mode === "openai"
      ? `KB: OpenAI ${status?.vectorStoreId ? `(${status.vectorStoreId})` : ""}`
      : "KB: Local (disk)";

  return (
    <main className="min-h-screen max-w-3xl mx-auto p-6 flex flex-col">
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
        Este asistente es referencial y no constituye asesoramiento legal. Para
        indicaciones específicas de tu caso, consulta a un profesional.
      </p>

      {/* Chat transcript */}
      <div className="flex-1 overflow-y-auto space-y-4 mb-4">
        {messages.map((m, idx) => {
          const isUser = m.role === "user";
          return (
            <div
              key={idx}
              className={`flex ${isUser ? "justify-end" : "justify-start"}`}
            >
              <div
                className={`max-w-[80%] border rounded px-3 py-2 whitespace-pre-wrap ${
                  isUser
                    ? "bg-blue-50 border-blue-200"
                    : "bg-white border-gray-200"
                }`}
              >
                <div className="text-sm">{m.content}</div>

                {/* Assistant-only tools */}
                {m.role === "assistant" && (
                  <>
                    {!!(m.citations && m.citations.length) && (
                      <div className="mt-3 text-xs">
                        <span className="font-medium">Fuentes:</span>
                        <div className="mt-1 flex flex-wrap gap-2">
                          {m.citations.map((c, i) => (
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

                    {!!(m.evidence && m.evidence.length) && (
                      <details className="mt-2 text-xs">
                        <summary className="cursor-pointer select-none font-medium">
                          Ver evidencias
                        </summary>
                        <div className="mt-2 space-y-2">
                          {m.evidence.map((ev, i) => (
                            <div key={`${ev.filename}-${i}`}>
                              <div className="font-medium">{ev.filename}</div>
                              <div className="mt-1 whitespace-pre-wrap bg-gray-50 border rounded p-2">
                                {ev.snippet}
                              </div>
                            </div>
                          ))}
                        </div>
                      </details>
                    )}

                    <div className="mt-2 text-right">
                      <button
                        onClick={() => copyAnswer(m.content, idx)}
                        className="text-xs border rounded px-2 py-1 bg-white hover:bg-gray-50"
                        aria-label="Copiar respuesta"
                        title="Copiar respuesta"
                      >
                        {copiedIdx === idx ? "¡Copiado!" : "Copiar"}
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
          );
        })}
        {loading && (
          <div className="text-xs text-gray-500">Generando respuesta…</div>
        )}
      </div>

      {/* Composer */}
      <div className="flex gap-2">
        <input
          className="flex-1 border rounded px-3 py-2"
          placeholder="Escribe tu consulta…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => (e.key === "Enter" ? send() : undefined)}
          disabled={loading}
        />
        <button className="border rounded px-4 py-2" onClick={send} disabled={loading}>
          {loading ? "Enviando…" : "Enviar"}
        </button>
      </div>
    </main>
  );
}