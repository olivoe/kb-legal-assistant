"use client";

import { useState, useRef, useMemo } from "react";
import type { ChatTurn } from "@/lib/sseClient";
import { streamChat } from "@/lib/sseClient";

type Evidence = { filename: string; snippet: string; score?: number };

export default function SseTestPage(): JSX.Element {
  const [message, setMessage] = useState("que dice el articulo 123 del codigo procesal?");
  const [nocache, setNocache] = useState(false);
  const [answer, setAnswer] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [eventsLog, setEventsLog] = useState<string[]>([]);
  const [hdr, setHdr] = useState<Record<string, string>>({});

  // Sources state (from cached JSON after stream)
  const [sourcesLoading, setSourcesLoading] = useState(false);
  const [citations, setCitations] = useState<string[]>([]);
  const [evidence, setEvidence] = useState<Evidence[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const abortRef = useRef<AbortController | null>(null);

  const history: ChatTurn[] = []; // keep your history here if needed

  function pushEvent(line: string) {
    setEventsLog((p) => {
      const next = [...p, line];
      return next.length > 200 ? next.slice(-200) : next;
    });
  }

  function groupByFile(ev: Evidence[]): Record<string, Evidence[]> {
    const map: Record<string, Evidence[]> = {};
    for (const e of ev) {
      (map[e.filename] ||= []).push(e);
    }
    return map;
  }

  const grouped = useMemo(() => groupByFile(evidence), [evidence]);

  // Fallback: parse [filename] tags from streamed text if JSON fetch fails
  function parseBracketSources(s: string): string[] {
    const out = new Set<string>();
    const re = /\[([^\]\n]+)\]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(s))) {
      const token = m[1].trim();
      // Heuristic: likely a file if it has a dot extension or underscores
      if (/\.[a-z0-9]{2,5}$/i.test(token) || /[_-]/.test(token)) out.add(token);
    }
    return [...out];
  }

  async function fetchCachedJsonForSources() {
    try {
      setSourcesLoading(true);
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message, history }),
      });

      // Merge any response headers we care about
      const hobj: Record<string, string> = {};
      for (const [k, v] of res.headers.entries()) hobj[k.toLowerCase()] = v;
      setHdr((prev) => ({ ...prev, ...hobj }));

      const data = await res.json().catch(() => null);
      if (data && typeof data === "object") {
        setCitations(Array.isArray(data.citations) ? data.citations : []);
        setEvidence(Array.isArray(data.evidence) ? data.evidence : []);
        if (!data.citations?.length) {
          // fallback parse
          const parsed = parseBracketSources(answer);
          setCitations(parsed);
        }
      } else {
        // fallback parse
        const parsed = parseBracketSources(answer);
        setCitations(parsed);
        setEvidence([]);
      }
    } catch (err: any) {
      pushEvent(`ERROR(fetch JSON): ${err?.message ?? String(err)}`);
      const parsed = parseBracketSources(answer);
      setCitations(parsed);
      setEvidence([]);
    } finally {
      setSourcesLoading(false);
    }
  }

  const send = async () => {
    if (streaming) return;
    setAnswer("");
    setEventsLog([]);
    setHdr({});
    setCitations([]);
    setEvidence([]);
    setExpanded(new Set());
    setStreaming(true);
    abortRef.current = new AbortController();

    try {
      await streamChat({
        message,
        history,
        nocache,
        onDelta: (d) => {
          setAnswer((p) => p + d);
          pushEvent(`[response.output_text.delta] ${JSON.stringify({ delta: d })}`);
        },
        onEvent: (evt, data) =>
          pushEvent(`[${evt}] ${typeof data === "string" ? data : JSON.stringify(data)}`),
        onDone: async () => {
          setStreaming(false);
          // Grab the cached JSON (should be HIT now) to populate sources
          await fetchCachedJsonForSources();
        },
        onHeaders: (h) => setHdr(h),
        signal: abortRef.current.signal,
      });
    } catch (err: any) {
      pushEvent(`ERROR: ${err?.message ?? String(err)}`);
      setStreaming(false);
    }
  };

  const cancel = () => {
    abortRef.current?.abort();
    setStreaming(false);
  };

  const toggleExpand = (fname: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(fname)) next.delete(fname);
      else next.add(fname);
      return next;
    });
  };

  return (
    <div style={{ maxWidth: 920, margin: "2rem auto", padding: "0 1rem", fontFamily: "ui-sans-serif, system-ui" }}>
      <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 12 }}>SSE Test</h1>

      <label style={{ display: "block", fontWeight: 600, marginBottom: 6 }}>Message</label>
      <textarea
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        rows={3}
        style={{ width: "100%", padding: 10, border: "1px solid #ddd", borderRadius: 6 }}
      />

      <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 10, flexWrap: "wrap" }}>
        <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input type="checkbox" checked={nocache} onChange={(e) => setNocache(e.target.checked)} />
          Force nocache (MISS)
        </label>

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

      {/* Response headers */}
      <div style={{ marginTop: 16 }}>
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

      {/* Answer */}
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
          style={{
            border: "1px solid #eee",
            borderRadius: 6,
            padding: 12,
            background: "#fff",
          }}
        >
          {sourcesLoading ? (
            <em style={{ color: "#666" }}>Loading sources…</em>
          ) : citations.length === 0 && evidence.length === 0 ? (
            <span>—</span>
          ) : (
            <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {/* Show unique filenames: prefer evidence grouping; else fall back to citations */}
              {(Object.keys(grouped).length ? Object.keys(grouped) : citations).map((fname) => {
                const items = grouped[fname] || [];
                const isOpen = expanded.has(fname);
                return (
                  <li key={fname} style={{ marginBottom: 10 }}>
                    <button
                      onClick={() => (items.length ? toggleExpand(fname) : undefined)}
                      title={items.length ? "Click to toggle snippet(s)" : "No snippet available"}
                      style={{
                        all: "unset",
                        cursor: items.length ? "pointer" : "default",
                        fontWeight: 600,
                        borderBottom: "1px dotted #999",
                      }}
                    >
                      {fname}
                      {items.length ? (isOpen ? " ▼" : " ▶") : ""}
                    </button>
                    {isOpen && items.length > 0 && (
                      <div
                        style={{
                          marginTop: 6,
                          padding: "8px 10px",
                          border: "1px solid #eee",
                          borderRadius: 6,
                          background: "#fafafa",
                          fontSize: 14,
                          lineHeight: 1.4,
                          whiteSpace: "pre-wrap",
                        }}
                      >
                        {items.map((ev, idx) => (
                          <div key={idx} style={{ marginBottom: idx < items.length - 1 ? 10 : 0 }}>
                            {typeof ev.score === "number" && (
                              <div style={{ color: "#555", fontSize: 12, marginBottom: 4 }}>
                                score: {ev.score.toFixed(3)}
                              </div>
                            )}
                            {ev.snippet}
                          </div>
                        ))}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      {/* Events */}
      <div style={{ marginTop: 18 }}>
        <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>Events</h2>
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
          {eventsLog.length ? (
            <ul style={{ paddingLeft: 16, margin: 0 }}>
              {eventsLog.map((l, i) => (
                <li key={i}>{l}</li>
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