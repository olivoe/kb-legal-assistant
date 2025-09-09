"use client";
import { useState } from "react";

type Msg = { role: "user" | "assistant"; content: string };

export default function Home() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");

  async function send() {
    if (!input.trim()) return;
    const userMsg: Msg = { role: "user", content: input };
    setMessages((m) => [...m, userMsg]);
    setInput("");

    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: userMsg.content }),
    });

    const data = await res.json();
    setMessages((m) => [...m, { role: "assistant", content: data.answer }]);
  }

  return (
    <main style={{ padding: 24, maxWidth: 800, margin: "0 auto" }}>
      <h1 style={{ fontSize: 22, fontWeight: 600, marginBottom: 12 }}>
        Asistente Legal (KB-first)
      </h1>

      <ul style={{ listStyle: "none", padding: 0, marginBottom: 16 }}>
        {messages.map((m, i) => (
          <li key={i} style={{ marginBottom: 8 }}>
            <strong>{m.role === "user" ? "Tú" : "Asistente"}:</strong>{" "}
            {m.content}
          </li>
        ))}
      </ul>

      <div style={{ display: "flex", gap: 8 }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => (e.key === "Enter" ? send() : null)}
          placeholder="Escribe tu pregunta…"
          style={{ flex: 1, border: "1px solid #ccc", borderRadius: 6, padding: "8px 10px" }}
        />
        <button onClick={send} style={{ border: "1px solid #ccc", borderRadius: 6, padding: "8px 14px" }}>
          Enviar
        </button>
      </div>
    </main>
  );
}
