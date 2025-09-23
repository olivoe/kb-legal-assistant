"use client";

import { useEffect, useMemo, useRef, useState } from "react";
// IMPORTANT: keep these relative paths exactly as written
import type { ChatTurn } from "../lib/sseClient";
import { streamChat } from "../lib/sseClient";

type Evidence = { filename: string; snippet: string; score?: number };

export default function SseTestPage(): JSX.Element {
  const [message, setMessage] = useState("que dice el articulo 123 del codigo procesal?");
  const [nocache, setNocache] = useState(false);
  const [answer, setAnswer] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [eventsLog, setEventsLog] = useState<string[]>([]);
  const [hdr, setHdr] = useState<Record<string, string>>({});
  const [sourcesLoading, setSourcesLoading] = useState(false);
  const [citations, setCitations] = useState<string[]>([]);
  const [evidence, setEvidence] = useState<Evidence[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const abortRef = useRef<AbortController | null>(null);
  const fetchedSourcesOnceRef = useRef(false);
  const history: ChatTurn[] = [];

  // ————————————————— DIAGNOSTICS —————————————————
  function pushEvent(line: string) {
    // also log to console for visibility
    // eslint-disable-next-line no-console
    console.log("[SSE-TEST]", line);
    setEventsLog((p) => {
      const next = [...p, line];
      return next.length > 400 ? next.slice(-400) : next;
    });
  }

  useEffect(() => {
    pushEvent("[client] mounted");
    // last resort: in-your-face proof hydration ran
    // (remove after debugging)
    try { alert("SSE Test page mounted (client hydrated)"); } catch {}
  }, []);

  // ————————————————— HELPERS —————————————————
  function groupByFile(ev: Evidence[]): Record<string, Evidence[]> {
    const map: Record<string, Evidence[]> = {};
    for (const e of ev) (map[e.filename] ||= []).push(e);
    return map;
  }
  const grouped = useMemo(() => groupByFile(evidence), [evidence]);

  function parseBracketSources(s: string): string[] {
    const out = new Set<string>();
    const re = /\[([^\]\n]+)\]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(s))) {
      const token = m[1].trim();
      if (/\.[a-z0-9]{2,5}$/i.test(token) || /[_-]/.test(token)) out.add(token);
    }
    return [...out];
  }

  async function fetchCachedJsonForSources() {
    try {
      setSourcesLoading(true);
      pushEvent("[client] fetching cached JSON for sources…");

      const res = await fetch("/api/chat?limit=5", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [...history, { role: "user", content: message }] }),
        cache: "no-store",
      });

      const hobj: Record<string, string> = {};
      for (const [k, v] of res.headers.entries()) hobj[k.toLowerCase()] = v;
      setHdr((prev) => ({ ...prev, ...hobj }));
      pushEvent(`[cached-json.headers] ${JSON.stringify(hobj)}`);

      const data = await res.json().catch(() => null);
      pushEvent(`[cached-json.body] ${JSON.stringify(data)}`);

      const topk: Array<{ file: string; score: number; id: string; start: number; end: number }> =
        (data && Array.isArray((data as any).topk)) ? (data as any).topk : [];

      if (!topk.length) {
        const parsed = parseBracketSources(answer);
        setCitations(parsed);
        setEvidence([]);
        return;
      }

      const ev: Evidence[] = [];
      for (const t of topk) {
        try {
          const want = Math.max(800, (t.end - t.start) + 200);
          const pvRes = await fetch(`/api/kb/peek-file?file=${encodeURIComponent(t.file)}&n=${want}`, { cache: "no-store" });
          const pv = await pvRes.json().catch(() => null) as { preview?: string };
          const full = (pv && typeof pv.preview === "string") ? pv.preview : "";

          let snippet = full;
          if (full && Number.isFinite(t.start) && Number.isFinite(t.end)) {
            const a = Math.max(0, Math.min(full.length, t.start - 50));
            const b = Math.max(0, Math.min(full.length, t.end + 50));
            if (b > a) snippet = full.slice(a, b);
          }
          ev.push({ filename: t.file, snippet: snippet || `(chunk ${t.id} from ${t.file})`, score: t.score });
        } catch {
          ev.push({ filename: t.file, snippet: `(chunk ${t.id} from ${t.file})`, score: t.score });
        }
      }
      setEvidence(ev);
      setCitations([...new Set(topk.map(t => t.file))]);
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
    try {
      alert("Send clicked"); // guaranteed visible
      if (streaming) { pushEvent("[client] send() ignored (already streaming)"); return; }

      setAnswer("");
      setEventsLog((prev) => [...prev, "[client] clearing events & starting stream…"]);
      setHdr({});
      setCitations([]);
      setEvidence([]);
      setExpanded(new Set());
      setStreaming(true);
fetchedSourcesOnceRef.current = false;        // <-- reset guard
      abortRef.current = new AbortController();

      pushEvent("[client] starting stream…");

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
          pushEvent("[client] stream done; fetching sources JSON…");
          setStreaming(false);
          if (!fetchedSourcesOnceRef.current) {
            fetchedSourcesOnceRef.current = true;
            await fetchCachedJsonForSources();
          }
        },
        onHeaders: (h) => setHdr(h),
        signal: abortRef.current!.signal,
      });      
    } catch (err: any) {
      pushEvent(`ERROR(streamChat): ${err?.message ?? String(err)}`);
      setStreaming(false);
    }
  };

  const cancel = () => {
    try { alert("Cancel clicked"); } catch {}
    abortRef.current?.abort();
    setStreaming(false);
    pushEvent("[client] aborted");
  };

  // Local test buttons
  const testEvent = () => { try { alert("Test event clicked"); } catch {}; pushEvent("[client] test event"); };
  const ping = async () => {
    try {
      alert("Ping clicked");
      const res = await fetch("/api/ping", { cache: "no-store" });
      const headers: Record<string, string> = {};
      for (const [k, v] of res.headers.entries()) headers[k.toLowerCase()] = v;
      pushEvent(`[ping.headers] ${JSON.stringify(headers)}`);
      const text = await res.text().catch(() => "");
      pushEvent(`[ping.body] ${text}`);
    } catch (e: any) {
      pushEvent(`[ping.error] ${e?.message ?? String(e)}`);
    }
  };

  const toggleExpand = (fname: string) => {
    setExpanded((prev) => {
      const next = new Set(prev); if (next.has(fname)) next.delete(fname); else next.add(fname); return next;
    });
  };

  return (
    <div style={{ maxWidth: 920, margin: "2rem auto", padding: "0 1rem", fontFamily: "ui-sans-serif, system-ui" }}>
      <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 12 }}>
        SSE Test <small style={{ fontSize: 12, color: "#666" }}>(events: {eventsLog.length})</small>
      </h1>

      <label style={{ display: "block", fontWeight: 600, marginBottom: 6 }}>Message</label>
      <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={3}
        style={{ width: "100%", padding: 10, border: "1px solid #ddd", borderRadius: 6 }}
      />

      <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 10, flexWrap: "wrap" }}>
        <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input type="checkbox" checked={nocache} onChange={(e) => setNocache(e.target.checked)} />
          Force nocache (MISS)
        </label>

        <button onClick={() => { try { void send(); } catch (e) { pushEvent("send() throw"); } }}
          disabled={streaming}
          style={{ padding: "8px 14px", borderRadius: 6, border: "1px solid #111",
                   background: streaming ? "#eee" : "#111", color: streaming ? "#111" : "#fff",
                   cursor: streaming ? "not-allowed" : "pointer" }}>
          {streaming ? "Streaming…" : "Send"}
        </button>

        {streaming && (
          <button onClick={() => { try { void cancel(); } catch (e) { pushEvent("cancel() throw"); } }}
            style={{ padding: "8px 14px", borderRadius: 6, border: "1px solid #b91c1c",
                     background: "#fff", color: "#b91c1c", cursor: "pointer" }}>
            Cancel
          </button>
        )}

        <button onClick={testEvent}
          style={{ padding: "8px 10px", borderRadius: 6, border: "1px solid #888", background: "#fafafa", cursor: "pointer" }}>
          Test event
        </button>

        <button onClick={() => { try { void ping(); } catch(e) { pushEvent("ping() throw"); } }}
          style={{ padding: "8px 10px", borderRadius: 6, border: "1px solid #888", background: "#fafafa", cursor: "pointer" }}>
          Ping
        </button>
      </div>

      <div style={{ marginTop: 16 }}>
        <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 6 }}>Response headers</h2>
        <div style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                      fontSize: 13, border: "1px solid #eee", borderRadius: 6, padding: 12, background: "#fff" }}>
          {Object.keys(hdr).length ? (
            <ul style={{ paddingLeft: 16, margin: 0 }}>
              {Object.entries(hdr).map(([k, v]) => (<li key={k}><strong>{k}</strong>: {v}</li>))}
            </ul>
          ) : "—"}
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
          {sourcesLoading ? (<em style={{ color: "#666" }}>Loading sources…</em>)
          : citations.length === 0 && evidence.length === 0 ? (<span>—</span>)
          : (
            <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {(Object.keys(grouped).length ? Object.keys(grouped) : citations).map((fname) => {
                const items = grouped[fname] || []; const isOpen = expanded.has(fname);
                return (
                  <li key={fname} style={{ marginBottom: 10 }}>
                    <button onClick={() => (items.length ? toggleExpand(fname) : undefined)}
                      title={items.length ? "Click to toggle snippet(s)" : "No snippet available"}
                      style={{ all: "unset", cursor: items.length ? "pointer" : "default",
                               fontWeight: 600, borderBottom: "1px dotted #999" }}>
                      {fname}{items.length ? (isOpen ? " ▼" : " ▶") : ""}
                    </button>
                    {isOpen && items.length > 0 && (
                      <div style={{ marginTop: 6, padding: "8px 10px", border: "1px solid #eee",
                                    borderRadius: 6, background: "#fafafa", fontSize: 14, lineHeight: 1.4, whiteSpace: "pre-wrap" }}>
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

      <div style={{ marginTop: 18 }}>
        <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>Events</h2>
        <div style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                      fontSize: 13, border: "1px solid #eee", borderRadius: 6, padding: 12, background: "#fff" }}>
          {eventsLog.length ? (
            <ul style={{ paddingLeft: 16, margin: 0 }}>
              {eventsLog.map((l, i) => (<li key={i}>{l}</li>))}
            </ul>
          ) : "—"}
        </div>
      </div>
    </div>
  );
}