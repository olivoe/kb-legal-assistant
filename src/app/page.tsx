"use client";

import { useState } from "react";

type ChatReply = {
  answer: string;
  citations?: string[];
  error?: boolean;
  message?: string;
};

export default function Home() {
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [history, setHistory] = useState<ChatReply[]>([]);

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

      const data: ChatReply = await res.json();
      setHistory((h) => [{ answer: data.answer, citations: data.citations || [] }, ...h]);
    } catch {
      setHistory((h) => [{ answer: "Backend request failed.", citations: [] }, ...h]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen max-w-3xl mx-auto p-6">
      <h1 className="text-2xl font-semibold mb-4">KB-first Legal Assistant (ES)</h1>

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
            <p className="whitespace-pre-wrap">{r.answer}</p>
            {!!(r.citations && r.citations.length) && (
              <div className="mt-3 text-sm">
                <span className="font-medium">Citations:</span>{" "}
                {r.citations.map((c, i) => (
                  <span
                    key={`${c}-${i}`}
                    className="inline-block bg-gray-100 border rounded px-2 py-0.5 mr-2 mt-2"
                  >
                    {c}
                  </span>
                ))}
              </div>
            )}
          </li>
        ))}
      </ul>
    </main>
  );
}
