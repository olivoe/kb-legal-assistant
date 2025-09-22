// src/pages/sse-test.tsx
import * as React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { streamChat } from "@/lib/sseClient";

type Evidence = { filename: string; snippet: string; score?: number };

export default function SseTestPage() {
  // --- URL param helpers (so you can deep-link) ---
  const params = useMemo(() => new URLSearchParams(typeof window !== "undefined" ? window.location.search : ""), []);
  const qp = (k: string, d = "") => params.get(k) ?? d;

  // --- Inputs ---
  const [message, setMessage] = useState(qp("m", "que dice el articulo 123 del codigo procesal?"));
  const [nocache, setNocache] = useState(qp("nocache") === "1");
  const [hybrid, setHybrid] = useState(qp("hybrid", "1") !== "0"); // default on
  const [overfetch, setOverfetch] = useState<number>(Number(qp("overfetch", "9")) || 9);
  const [rrfK, setRrfK] = useState<number>(Number(qp("rrf_k", "60")) || 60);
  const [scoreMin, setScoreMin] = useState<number>(Number(qp("score_min", "0.28")) || 0.28);
  const [maxHits, setMaxHits] = useState<number>(Number(qp("max_hits", "3")) || 3);

  // --- Output state ---
  const [answer, setAnswer] = useState<string>("—");
  const [headers, setHeaders] = useState<Record<string, string>>({});
  const [events, setEvents] = useState<string[]>([]);
  const [citations, setCitations] = useState<string[]>([]);
  const [evidence, setEvidence] = useState<Evidence[]>([]);

  // For aborting a running stream
  const abortRef = useRef<AbortController | null>(null);

  function logEvent(line: string) {
    setEvents((prev) => (prev.length > 500 ? [...prev.slice(-500), line] : [...prev, line]));
  }

  async function handleSend() {
    // Reset UI
    setAnswer("");
    setEvents([]);
    setCitations([]);
    setEvidence([]);

    // Abort any previous stream
    if (abortRef.current) abortRef.current.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    try {
      await streamChat({
        message,
        history: [],
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
        },
        onDelta(delta) {
          setAnswer((s) => (s ? s + delta : delta));
        },
        onEvent(evt, data) {
          if (evt === "sources") {
            const obj = data as { citations?: string[]; evidence?: Evidence[] };
            if (Array.isArray(obj?.citations)) setCitations(obj!.citations!);
            if (Array.isArray(obj?.evidence)) setEvidence(obj!.evidence!);
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
        },
      });
    } catch (err: any) {
      logEvent(`error ${err?.message || String(err)}`);
      abortRef.current = null;
    }
  }

  // Keep URL in sync (handy for sharing a repro)
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

  return (
    <div style={{ maxWidth: 920, margin: "2rem auto", padding: "0 1rem", fontFamily: "ui-sans-serif, system-ui" }}>
      <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 12 }}>SSE Test</h1>

      <label style={{ display: "block", fontWeight: 600, marginBottom: 6 }}>Message</label>
      <textarea
        rows={3}
        style={{ width: "100%", padding: 10, border: "1px solid #ddd", borderRadius: 6 }}
        value={message}
        onChange={(e) => setMessage(e.target.value)}
      />

      <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input type="checkbox" checked={nocache} onChange={(e) => setNocache(e.target.checked)} />
          Force nocache (MISS)
        </label>

        <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input type="checkbox" checked={hybrid} onChange={(e) => setHybrid(e.target.checked)} />
          Hybrid (RRF fusion)
        </label>

        <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ minWidth: 82 }}>Overfetch</span>
          <input
            type="number"
            min={1}
            value={overfetch}
            onChange={(e) => setOverfetch(Math.max(1, Number(e.target.value) || 1))}
            style={{ width: 90, padding: 6, border: "1px solid #ddd", borderRadius: 6 }}
          />
        </label>

        <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ minWidth: 50 }}>RRF k</span>
          <input
            type="number"
            min={1}
            value={rrfK}
            onChange={(e) => setRrfK(Math.max(1, Number(e.target.value) || 1))}
            style={{ width: 90, padding: 6, border: "1px solid #ddd", borderRadius: 6 }}
          />
        </label>

        <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ minWidth: 80 }}>Score min</span>
          <input
            type="number"
            step="0.01"
            value={scoreMin}
            onChange={(e) => setScoreMin(Number(e.target.value))}
            style={{ width: 90, padding: 6, border: "1px solid #ddd", borderRadius: 6 }}
          />
        </label>

        <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
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

      <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 12, flexWrap: "wrap" }}>
        <button
          onClick={handleSend}
          style={{ padding: "8px 14px", borderRadius: 6, border: "1px solid #111", background: "#111", color: "#fff", cursor: "pointer" }}
        >
          Send
        </button>
        {abortRef.current && (
          <button
            onClick={() => abortRef.current?.abort()}
            style={{ padding: "8px 14px", borderRadius: 6, border: "1px solid #c00", background: "#fff", color: "#c00", cursor: "pointer" }}
          >
            Abort
          </button>
        )}
      </div>

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
            overflow: "auto",
            whiteSpace: "pre-wrap",
          }}
        >
          {Object.keys(headers).length === 0 ? "—" : Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join(" \n")}
        </div>
      </div>

      <div style={{ marginTop: 18 }}>
        <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>Answer (streamed)</h2>
        <div style={{ whiteSpace: "pre-wrap", border: "1px solid #ddd", borderRadius: 6, padding: 12, minHeight: 90, background: "#fafafa" }}>
          {answer || "—"}
        </div>
      </div>

      <div style={{ marginTop: 18 }}>
        <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>Sources</h2>
        <div style={{ border: "1px solid #eee", borderRadius: 6, padding: 12, background: "#fff" }}>
          {citations.length === 0 && evidence.length === 0 ? (
            <span>—</span>
          ) : (
            <>
              {citations.length > 0 && (
                <div style={{ marginBottom: 8 }}>
                  <div style={{ fontWeight: 600, marginBottom: 4 }}>{citations.join(" ")}</div>
                </div>
              )}
              {evidence.map((e, i) => (
                <div key={`${e.filename}-${i}`} style={{ marginBottom: 8 }}>
                  <div style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace", fontSize: 13 }}>
                    {e.filename}{" "}
                    {typeof e.score === "number" ? <>(score {e.score.toFixed(3)})</> : null}
                  </div>
                  <div>{e.snippet}</div>
                </div>
              ))}
            </>
          )}
        </div>
      </div>

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
            whiteSpace: "pre-wrap",
          }}
        >
          {events.length ? events.join("\n") : "—"}
        </div>
      </div>
    </div>
  );
}