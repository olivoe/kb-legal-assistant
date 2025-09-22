// src/app/chat/page.tsx
"use client";

import * as React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { streamChat } from "@/lib/sseClient";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type Evidence = { filename: string; snippet: string; score?: number };
type ChatTurn = { role: "user" | "assistant"; content: string };

function formatHeaders(h: Record<string, string>) {
  const lines: string[] = [];
  Object.entries(h).forEach(([k, v]) => {
    if (k.startsWith("x-rag-") || k.startsWith("x-cache") || k === "x-runtime-ms") {
      lines.push(`${k}: ${v}`);
    }
  });
  return lines.length ? lines.sort().join("\n") : "—";
}

/* === Chips helpers === */
const chipStyle: React.CSSProperties = {
  fontSize: 12,
  padding: "2px 8px",
  borderRadius: 999,
  border: "1px solid #e5e7eb",
  background: "#f9fafb",
  color: "#111",
  cursor: "pointer",
};

const mdStyles: React.CSSProperties = {
  lineHeight: 1.55,
  fontSize: 14,
};
const mdBlockStyles: React.CSSProperties = {
  background: "#f6f8fa",
  border: "1px solid #e5e7eb",
  borderRadius: 8,
  padding: "10px 12px",
  whiteSpace: "pre-wrap",
  overflowX: "auto",
};

function scrollToSources() {
  const el = document.getElementById("sources");
  if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
}

/* === Persistence keys === */
const STORAGE_KEYS = {
  transcript: "kbla:messages",
  settings: "kbla:settings",
} as const;

export default function ChatPage() {
  // Status chip (cache + mode)
  const [status, setStatus] = useState<{ cache?: string; mode?: string }>({});

  // Deep-linkable params
  const params = useMemo(
    () => new URLSearchParams(typeof window !== "undefined" ? window.location.search : ""),
    []
  );
  const qp = (k: string, d = "") => params.get(k) ?? d;
  const hasParam = (k: string) => params.has(k);

  // Inputs
  const KB_MODE = process.env.NEXT_PUBLIC_KB_MODE || "embed";
  const [message, setMessage] = useState(qp("m", "que dice el articulo 123 del codigo procesal?"));
  const [nocache, setNocache] = useState(qp("nocache") === "1");
  const [hybrid, setHybrid] = useState(qp("hybrid", "1") !== "0");
  const [overfetch, setOverfetch] = useState<number>(Number(qp("overfetch", "9")) || 9);
  const [rrfK, setRrfK] = useState<number>(Number(qp("rrf_k", "60")) || 60);
  const [scoreMin, setScoreMin] = useState<number>(Number(qp("score_min", "0.28")) || 0.28);
  const [maxHits, setMaxHits] = useState<number>(Number(qp("max_hits", "3")) || 3);

  // Outputs (dev/debug panels)
  const [answer, setAnswer] = useState<string>("—");
  const [headers, setHeaders] = useState<Record<string, string>>({});
  const [events, setEvents] = useState<string[]>([]);
  const [citations, setCitations] = useState<string[]>([]);
  const [evidence, setEvidence] = useState<Evidence[]>([]);

  // Chat transcript + streaming state
  const [messages, setMessages] = useState<ChatTurn[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [draftAssistant, setDraftAssistant] = useState<string>("");

  // Refs
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  // When regenerating, we may want to REPLACE an existing assistant turn
  const regenReplaceIndexRef = useRef<number | null>(null);

  function logEvent(line: string) {
    setEvents((prev) => (prev.length > 500 ? [...prev.slice(-500), line] : [...prev, line]));
  }

  /* ---------- SEND (new message) ---------- */
  async function handleSend() {
    const msg = message.trim();
    if (!msg || isStreaming) return;

    // push the user turn into transcript
    const userTurn: ChatTurn = { role: "user", content: msg };
    setMessages((prev) => [...prev, userTurn]);

    // reset per-send UI bits
    setAnswer("");
    setEvents([]);
    setCitations([]);
    setEvidence([]);
    setDraftAssistant("");
    setIsStreaming(true);
    regenReplaceIndexRef.current = null; // not a regeneration

    if (abortRef.current) abortRef.current.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    try {
      await streamChat({
        message: msg,
        history: [...messages, userTurn],
        nocache,
        opts: {
          hybrid,
          overfetch,
          rrf_k: rrfK,
          score_min: scoreMin,
          max_hits: maxHits,
        },
        signal: ac.signal,
        onHeaders(h) {
          setHeaders(h);
          setStatus({
            cache: (h["x-cache"] || "").toUpperCase(),
            mode: h["x-rag-mode"] || (h["x-rag-hybrid"] === "1" ? "hybrid-rrf" : "embed-only"),
          });
        },
        onDelta(delta) {
          setAnswer((s) => (s ? s + delta : delta));
          setDraftAssistant((s) => (s ? s + delta : delta));
        },
        onEvent(evt, data) {
          if (evt === "sources") {
            const obj = data as { citations?: string[]; evidence?: Evidence[] };
            if (Array.isArray(obj?.citations)) setCitations(obj.citations!);
            if (Array.isArray(obj?.evidence)) setEvidence(obj.evidence!);
          }
          try {
            logEvent(`${evt} ${typeof data === "string" ? data : JSON.stringify(data)}`);
          } catch {
            logEvent(`${evt} ${String(data)}`);
          }
        },
        onDone() {
          logEvent("[DONE]");
          abortRef.current = null;
          setIsStreaming(false);
          setMessages((prev) =>
            draftAssistant.trim()
              ? [...prev, { role: "assistant", content: draftAssistant }]
              : prev
          );
          setDraftAssistant("");
        },
      });
    } catch (err: any) {
      logEvent(`error ${err?.message || String(err)}`);
      abortRef.current = null;
      setIsStreaming(false);
      setDraftAssistant("");
    }
  }

  /* ---------- REGENERATE (last user) ---------- */
  async function handleRegenerate() {
    if (isStreaming) return;
    // find the last user turn
    let lastUserIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") {
        lastUserIdx = i;
        break;
      }
    }
    if (lastUserIdx < 0) return;
    const userTurn = messages[lastUserIdx];

    // if an assistant follows immediately after that user, we will replace it
    const nextIdx = lastUserIdx + 1;
    const replaceIdx =
      nextIdx < messages.length && messages[nextIdx].role === "assistant" ? nextIdx : null;
    regenReplaceIndexRef.current = replaceIdx;

    // reset streaming UI
    setAnswer("");
    setEvents([]);
    setCitations([]);
    setEvidence([]);
    setDraftAssistant("");
    setIsStreaming(true);

    if (abortRef.current) abortRef.current.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    try {
      await streamChat({
        message: userTurn.content,
        // history is everything up to and including that user turn
        history: messages.slice(0, lastUserIdx + 1),
        nocache,
        opts: {
          hybrid,
          overfetch,
          rrf_k: rrfK,
          score_min: scoreMin,
          max_hits: maxHits,
        },
        signal: ac.signal,
        onHeaders(h) {
          setHeaders(h);
          setStatus({
            cache: (h["x-cache"] || "").toUpperCase(),
            mode: h["x-rag-mode"] || (h["x-rag-hybrid"] === "1" ? "hybrid-rrf" : "embed-only"),
          });
        },
        onDelta(delta) {
          setAnswer((s) => (s ? s + delta : delta));
          setDraftAssistant((s) => (s ? s + delta : delta));
        },
        onEvent(evt, data) {
          if (evt === "sources") {
            const obj = data as { citations?: string[]; evidence?: Evidence[] };
            if (Array.isArray(obj?.citations)) setCitations(obj.citations!);
            if (Array.isArray(obj?.evidence)) setEvidence(obj.evidence!);
          }
          try {
            logEvent(`${evt} ${typeof data === "string" ? data : JSON.stringify(data)}`);
          } catch {
            logEvent(`${evt} ${String(data)}`);
          }
        },
        onDone() {
          logEvent("[DONE]");
          abortRef.current = null;
          setIsStreaming(false);
          setMessages((prev) => {
            if (!draftAssistant.trim()) return prev;
            // replace or append
            if (regenReplaceIndexRef.current != null) {
              const arr = prev.slice();
              arr[regenReplaceIndexRef.current] = {
                role: "assistant",
                content: draftAssistant,
              };
              return arr;
            }
            return [...prev, { role: "assistant", content: draftAssistant }];
          });
          regenReplaceIndexRef.current = null;
          setDraftAssistant("");
        },
      });
    } catch (err: any) {
      logEvent(`error ${err?.message || String(err)}`);
      abortRef.current = null;
      setIsStreaming(false);
      setDraftAssistant("");
      regenReplaceIndexRef.current = null;
    }
  }

  function handleStop() {
    abortRef.current?.abort();
    abortRef.current = null;
    setIsStreaming(false);
    // keep whatever streamed so far in draftAssistant
  }

  function handleNewChat() {
    setMessages([]);
    setDraftAssistant("");
    setAnswer("—");
    setCitations([]);
    setEvidence([]);
    setEvents([]);
    try {
      localStorage.removeItem(STORAGE_KEYS.transcript);
    } catch {}
  }

  // Keep URL in sync for easy repro links
  useEffect(() => {
    if (typeof window === "undefined") return;
    const sp = new URLSearchParams();
    if (message) sp.set("m", message);
    if (nocache) sp.set("nocache", "1");
    sp.set("hybrid", hybrid ? "1" : "0");
    sp.set("overfetch", String(overfetch));
    sp.set("rrf_k", String(rrfK));
    sp.set("score_min", String(scoreMin));
    sp.set("max_hits", String(maxHits));
    const url = `${window.location.pathname}?${sp.toString()}`;
    window.history.replaceState(null, "", url);
  }, [message, nocache, hybrid, overfetch, rrfK, scoreMin, maxHits]);

  // Load from localStorage on mount (unless overridden via query params)
  useEffect(() => {
    try {
      const rawMsgs = localStorage.getItem(STORAGE_KEYS.transcript);
      if (rawMsgs) {
        const saved: ChatTurn[] = JSON.parse(rawMsgs);
        if (
          Array.isArray(saved) &&
          saved.every(
            (m) => m && typeof m.content === "string" && (m.role === "user" || m.role === "assistant")
          )
        ) {
          setMessages(saved);
        }
      }
    } catch {}

    try {
      const rawSettings = localStorage.getItem(STORAGE_KEYS.settings);
      if (rawSettings) {
        const s = JSON.parse(rawSettings) as {
          nocache?: boolean;
          hybrid?: boolean;
          overfetch?: number;
          rrfK?: number;
          scoreMin?: number;
          maxHits?: number;
        };
        if (!hasParam("nocache") && typeof s.nocache === "boolean") setNocache(s.nocache);
        if (!hasParam("hybrid") && typeof s.hybrid === "boolean") setHybrid(s.hybrid);
        if (!hasParam("overfetch") && typeof s.overfetch === "number") setOverfetch(s.overfetch);
        if (!hasParam("rrf_k") && typeof s.rrfK === "number") setRrfK(s.rrfK);
        if (!hasParam("score_min") && typeof s.scoreMin === "number") setScoreMin(s.scoreMin);
        if (!hasParam("max_hits") && typeof s.maxHits === "number") setMaxHits(s.maxHits);
      }
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Save transcript/settings to localStorage
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEYS.transcript, JSON.stringify(messages));
    } catch {}
  }, [messages]);
  useEffect(() => {
    try {
      localStorage.setItem(
        STORAGE_KEYS.settings,
        JSON.stringify({ nocache, hybrid, overfetch, rrfK, scoreMin, maxHits })
      );
    } catch {}
  }, [nocache, hybrid, overfetch, rrfK, scoreMin, maxHits]);

  // Auto-scroll transcript bottom
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, draftAssistant]);

  return (
    <div style={{ maxWidth: 920, margin: "2rem auto", padding: "0 1rem", fontFamily: "ui-sans-serif, system-ui" }}>
      <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 12 }}>KB Legal Assistant</h1>

      {/* Chips: cache/mode + KB_MODE */}
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8, flexWrap: "wrap" }}>
        <span
          style={{
            fontSize: 12,
            padding: "4px 8px",
            borderRadius: 6,
            background: "#eef",
            border: "1px solid #dbe",
            color: "#223",
          }}
          title="Cache · Mode"
        >
          {`${status.cache || "—"} · ${status.mode || "—"}`}
        </span>
        <span
          style={{
            fontSize: 12,
            padding: "4px 8px",
            borderRadius: 6,
            background: "#f3f3f3",
            border: "1px solid #e5e7eb",
            color: "#111",
          }}
          title="Knowledge base mode"
        >
          KB: {KB_MODE}
        </span>
        {KB_MODE !== "embed" && (
          <span style={{ fontSize: 12, color: "#b00" }}>Hybrid controls disabled (KB_MODE ≠ embed)</span>
        )}
      </div>

      {/* Transcript */}
      <div style={{ border: "1px solid #eee", borderRadius: 8, padding: 12, marginBottom: 12, background: "#fff" }}>
        {messages.length === 0 && !draftAssistant ? (
          <div style={{ color: "#666", fontSize: 14 }}>No messages yet. Type below and press Send.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {messages.map((m, i) => {
              const isUser = m.role === "user";
              return (
                <div
                  key={i}
                  style={{
                    alignSelf: isUser ? "flex-end" : "flex-start",
                    maxWidth: "85%",
                  }}
                >
                  <div
                    style={{
                      background: isUser ? "#eef3ff" : "#f7f7f7",
                      border: "1px solid #e5e7eb",
                      borderRadius: 10,
                      padding: "10px 12px",
                      maxWidth: "100%",
                    }}
                  >
                    {isUser ? (
                      <div style={{ whiteSpace: "pre-wrap" }}>{m.content}</div>
                    ) : (
                      <ReactMarkdown
                        remarkPlugins={[remarkGfm]}
                        components={{
                          code({ inline, children, ...props }) {
                            if (inline)
                              return (
                                <code
                                  {...props}
                                  style={{ padding: "0 3px", borderRadius: 4, background: "#f6f8fa" }}
                                >
                                  {children}
                                </code>
                              );
                            return (
                              <pre {...props} style={mdBlockStyles}>
                                <code>{children}</code>
                              </pre>
                            );
                          },
                          pre({ children, ...props }) {
                            return (
                              <pre {...props} style={mdBlockStyles}>
                                {children}
                              </pre>
                            );
                          },
                          table({ children, ...props }) {
                            return (
                              <div style={{ overflowX: "auto" }}>
                                <table {...props}>{children}</table>
                              </div>
                            );
                          },
                        }}
                        style={mdStyles}
                      >
                        {m.content}
                      </ReactMarkdown>
                    )}
                  </div>

                  {/* Chips under last assistant bubble */}
                  {!isUser && i === messages.length - 1 && citations.length > 0 && (
                    <div style={{ marginTop: 6, display: "flex", gap: 6, flexWrap: "wrap" }}>
                      {citations.map((c) => (
                        <span
                          key={c}
                          style={chipStyle}
                          onClick={scrollToSources}
                          title="View sources below"
                        >
                          {c}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}

            {/* Streaming draft bubble */}
            {draftAssistant && (
              <div style={{ alignSelf: "flex-start", maxWidth: "85%" }}>
                <div
                  style={{
                    background: "#f7f7f7",
                    border: "1px solid #e5e7eb",
                    borderRadius: 10,
                    padding: "10px 12px",
                    opacity: 0.9,
                  }}
                >
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={{
                      code({ inline, children, ...props }) {
                        if (inline)
                          return (
                            <code
                              {...props}
                              style={{ padding: "0 3px", borderRadius: 4, background: "#f6f8fa" }}
                            >
                              {children}
                            </code>
                          );
                        return (
                          <pre {...props} style={mdBlockStyles}>
                            <code>{children}</code>
                          </pre>
                        );
                      },
                      pre({ children, ...props }) {
                        return (
                          <pre {...props} style={mdBlockStyles}>
                            {children}
                          </pre>
                        );
                      },
                      table({ children, ...props }) {
                        return (
                          <div style={{ overflowX: "auto" }}>
                            <table {...props}>{children}</table>
                          </div>
                        );
                      },
                    }}
                    style={mdStyles}
                  >
                    {draftAssistant}
                  </ReactMarkdown>
                </div>

                {/* Chips while streaming */}
                {citations.length > 0 && (
                  <div style={{ marginTop: 6, display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {citations.map((c) => (
                      <span
                        key={`draft-${c}`}
                        style={chipStyle}
                        onClick={scrollToSources}
                        title="View sources below"
                      >
                        {c}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Anchor for auto-scroll */}
            <div ref={bottomRef} />
          </div>
        )}
      </div>

      {/* Composer */}
      <label style={{ display: "block", fontWeight: 600, marginBottom: 6 }}>Message</label>
      <textarea
        rows={3}
        style={{ width: "100%", padding: 10, border: "1px solid #ddd", borderRadius: 6 }}
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        onKeyDown={(e) => {
          // Shift+Enter -> newline; Enter -> send
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            if (!isStreaming) handleSend();
          }
          // still allow Cmd/Ctrl+Enter too
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            if (!isStreaming) handleSend();
          }
        }}
      />

      {/* Controls */}
      <div
        style={{
          marginTop: 12,
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          gap: 12,
          alignItems: "center",
        }}
      >
        <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input type="checkbox" checked={nocache} onChange={(e) => setNocache(e.target.checked)} />
          Force nocache (MISS)
        </label>

        <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input
            type="checkbox"
            checked={hybrid}
            onChange={(e) => setHybrid(e.target.checked)}
            disabled={KB_MODE !== "embed"}
            title={KB_MODE !== "embed" ? "Hybrid requiere KB_MODE=embed" : ""}
          />
          Hybrid (RRF)
        </label>

        <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{ minWidth: 84 }}>Overfetch</span>
          <input
            type="number"
            min={1}
            value={overfetch}
            onChange={(e) => setOverfetch(Math.max(1, Number(e.target.value) || 1))}
            style={{ width: 90, padding: 6, border: "1px solid #ddd", borderRadius: 6 }}
          />
        </label>

        <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{ minWidth: 54 }}>RRF k</span>
          <input
            type="number"
            min={1}
            value={rrfK}
            onChange={(e) => setRrfK(Math.max(1, Number(e.target.value) || 1))}
            style={{ width: 90, padding: 6, border: "1px solid #ddd", borderRadius: 6 }}
          />
        </label>

        <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{ minWidth: 88 }}>Score min</span>
          <input
            type="number"
            step="0.01"
            value={scoreMin}
            onChange={(e) => setScoreMin(Number(e.target.value))}
            style={{ width: 90, padding: 6, border: "1px solid #ddd", borderRadius: 6 }}
          />
        </label>

        <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{ minWidth: 70 }}>Max hits</span>
          <input
            type="number"
            min={1}
            value={maxHits}
            onChange={(e) => setMaxHits(Math.max(1, Number(e.target.value) || 1))}
            style={{ width: 90, padding: 6, border: "1px solid #ddd", borderRadius: 6 }}
          />
        </label>
      </div>

      {/* Actions */}
      <div style={{ display: "flex", gap: 12, marginTop: 12, flexWrap: "wrap" }}>
        <button
          onClick={handleSend}
          aria-label="Send message"
          data-testid="send-button"
          disabled={isStreaming}
          style={{
            padding: "8px 14px",
            borderRadius: 6,
            border: "1px solid #111",
            background: isStreaming ? "#666" : "#111",
            color: "#fff",
            cursor: isStreaming ? "not-allowed" : "pointer",
            opacity: isStreaming ? 0.8 : 1,
          }}
        >
          {isStreaming ? "Sending…" : "Send (Enter)"}
        </button>

        <button
          onClick={handleRegenerate}
          aria-label="Regenerate last answer"
          disabled={
            isStreaming ||
            messages.findLastIndex
              ? messages.findLastIndex((m) => m.role === "user") < 0
              : // Node <20 polyfill using loop:
                (() => {
                  let idx = -1;
                  for (let i = messages.length - 1; i >= 0; i--) {
                    if (messages[i].role === "user") {
                      idx = i;
                      break;
                    }
                  }
                  return idx < 0;
                })()
          }
          style={{
            padding: "8px 14px",
            borderRadius: 6,
            border: "1px solid #bbb",
            background: "#fff",
            color: "#111",
            cursor: isStreaming ? "not-allowed" : "pointer",
            opacity: isStreaming ? 0.6 : 1,
          }}
        >
          Regenerate
        </button>

        <button
          onClick={handleStop}
          disabled={!abortRef.current}
          aria-label="Stop streaming"
          style={{
            padding: "8px 14px",
            borderRadius: 6,
            border: "1px solid #bbb",
            background: abortRef.current ? "#f3f3f3" : "#fafafa",
            color: "#333",
            cursor: abortRef.current ? "pointer" : "not-allowed",
            opacity: abortRef.current ? 1 : 0.6,
          }}
        >
          Stop
        </button>

        <button
          onClick={handleNewChat}
          aria-label="New chat"
          style={{
            padding: "8px 14px",
            borderRadius: 6,
            border: "1px solid #ddd",
            background: "#fff",
            color: "#111",
            cursor: "pointer",
          }}
        >
          New chat
        </button>
      </div>

      {/* Debug: compact response headers */}
      <div style={{ marginTop: 16 }}>
        <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 6 }}>Response headers</h2>
        <pre
          style={{
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
            fontSize: 13,
            border: "1px solid #eee",
            borderRadius: 6,
            padding: 12,
            background: "#fff",
            whiteSpace: "pre-wrap",
          }}
        >
          {formatHeaders(headers)}
        </pre>
      </div>

      {/* Answer (still visible for dev) */}
      <div style={{ marginTop: 18 }}>
        <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>Answer (streamed)</h2>
        <div
          style={{
            whiteSpace: "pre-wrap",
            border: "1px solid #ddd",
            borderRadius: 6,
            padding: 12,
            minHeight: 90,
            background: "#fafafa",
          }}
        >
          {answer || "—"}
        </div>
      </div>

      {/* Sources */}
      <div style={{ marginTop: 18 }}>
        <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>Sources</h2>
        <div
          id="sources"
          style={{ border: "1px solid #eee", borderRadius: 6, padding: 12, background: "#fff" }}
        >
          {citations.length ? (
            <>
              <div style={{ marginBottom: 8 }}>{citations.join(" ")}</div>
              {evidence.map((e, i) => (
                <div key={`${e.filename}-${i}`} style={{ marginBottom: 10 }}>
                  <strong>
                    {e.filename}
                    {typeof e.score === "number" ? ` (score ${e.score})` : ""}
                  </strong>
                  <div style={{ whiteSpace: "pre-wrap" }}>{e.snippet}</div>
                </div>
              ))}
            </>
          ) : (
            <span>—</span>
          )}
        </div>
      </div>

      {/* Events log */}
      <div style={{ marginTop: 18 }}>
        <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>Events</h2>
        <pre
          style={{
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
            fontSize: 13,
            border: "1px solid #eee",
            borderRadius: 6,
            padding: 12,
            background: "#fff",
            whiteSpace: "pre-wrap",
          }}
        >
          {events.length ? events.join("\n") : "—"}
        </pre>
      </div>
    </div>
  );
}