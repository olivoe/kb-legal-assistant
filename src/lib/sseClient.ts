// src/lib/sseClient.ts
type Evidence = { filename: string; snippet: string; score?: number };

type StreamArgs = {
  message: string;
  history: { role: "user" | "assistant"; content: string }[];
  nocache?: boolean;
  opts?: {
    hybrid?: boolean;
    overfetch?: number;
    rrf_k?: number;
    score_min?: number;
    max_hits?: number;
  };
  signal?: AbortSignal;
  onHeaders?: (h: Record<string, string>) => void;
  onDelta?: (delta: string) => void;
  onEvent?: (event: string, data: unknown) => void;
  onDone?: () => void;
};

export async function streamChat({
  message,
  history,
  nocache,
  opts,
  signal,
  onHeaders,
  onDelta,
  onEvent,
  onDone,
}: StreamArgs) {
  const payload = { message, history, nocache, opts };

  const resp = await fetch("/api/chat?stream=1", {
    method: "POST",                           // ← important
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),            // ← important
    signal,
  });

  // expose headers to the UI
  const headers: Record<string, string> = {};
  resp.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
  onHeaders?.(headers);

  if (!resp.ok) {
    const text = await resp.text().catch(() => resp.statusText);
    throw new Error(`HTTP ${resp.status}: ${text.slice(0, 300)}`);
  }

  // must be SSE
  const ct = resp.headers.get("content-type") || "";
  if (!ct.includes("text/event-stream")) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Expected SSE, got: ${ct} ${text.slice(0, 300)}`);
  }

  // read & parse SSE
  const reader = resp.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const flush = (chunk: string) => {
    buffer += chunk;
    // SSE frames are separated by blank line
    const frames = buffer.split(/\n\n/);
    buffer = frames.pop() || ""; // keep partial

    for (const frame of frames) {
      // lines like: "event: foo" and "data: {..}"
      const lines = frame.split(/\n/);
      let event = "message";
      let dataRaw = "";

      for (const line of lines) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) dataRaw += line.slice(5).trim();
      }

      if (dataRaw === "[DONE]") {
        onDone?.();
        return "DONE";
      }

      // special handler for delta event
      if (event === "response.output_text.delta") {
        try {
          const { delta } = JSON.parse(dataRaw) as { delta?: string };
          if (typeof delta === "string" && delta) onDelta?.(delta);
        } catch {
          // ignore parse errors
        }
        continue;
      }

      // pass through other events (e.g., init, sources)
      try {
        const data = dataRaw ? JSON.parse(dataRaw) : dataRaw;
        onEvent?.(event, data);
      } catch {
        onEvent?.(event, dataRaw);
      }
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      flush(decoder.decode(value, { stream: true }));
    }
  } finally {
    // flush any trailing partial lines
    if (buffer) {
      try { flush("\n\n"); } catch {}
    }
    onDone?.();
  }
}