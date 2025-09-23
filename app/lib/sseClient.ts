// app/lib/sseClient.ts
export type ChatTurn = { role: "user" | "assistant" | "system"; content: string };

type StreamOptions = {
  message: string;
  history?: ChatTurn[];
  nocache?: boolean;
  onDelta?: (text: string) => void;
  onEvent?: (event: string, data?: unknown) => void;
  onDone?: () => void;
  onHeaders?: (headers: Record<string, string>) => void;
  signal?: AbortSignal;
  limit?: number;
};

export async function streamChat(opts: StreamOptions): Promise<void> {
  const {
    message,
    history = [],
    nocache = false,
    onDelta,
    onEvent,
    onDone,
    onHeaders,
    signal,
    limit = 3,
  } = opts;

  const messages = [
    ...history.map(h => ({ role: h.role, content: h.content })),
    { role: "user", content: message },
  ];

  const res = await fetch(`/api/chat?limit=${limit}&stream=1`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "text/event-stream",
      "Cache-Control": "no-cache",
      ...(nocache ? { "x-nocache": "1" } : {}),
    },
    body: JSON.stringify({ messages }),
    signal,
  }).catch((e) => {
    onEvent?.("fetch-error", e?.message || String(e));
    onDone?.();
    return undefined as any;
  });

  if (!res) return;

  const hdrs: Record<string, string> = {};
  for (const [k, v] of res.headers.entries()) hdrs[k.toLowerCase()] = v;
  onHeaders?.(hdrs);

  const ct = (hdrs["content-type"] || "").toLowerCase();
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    onEvent?.("http-error", `HTTP ${res.status} ${res.statusText}${txt ? ` • ${txt}` : ""}`);
    onDone?.();
    return;
  }

  // If the server didn’t send SSE, try to treat it as plain text/json for visibility.
  if (!ct.includes("text/event-stream")) {
    const txt = await res.text().catch(() => "");
    if (txt) onDelta?.(txt);
    onEvent?.("non-sse", ct || "no content-type");
    onDone?.();
    return;
  }

  if (!res.body) {
    onEvent?.("no-body", "ReadableStream missing");
    onDone?.();
    return;
  }

  // Stream parse: accumulate into buffer and split at \n\n frame boundaries
  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Handle \r\n as well; normalize to \n
      buffer = buffer.replace(/\r\n/g, "\n");

      let sep;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);

        // Each frame may contain multiple lines (event:, id:, data:)
        const lines = frame.split("\n");
        for (const rawLine of lines) {
          const line = rawLine.trimStart();
          if (!line.startsWith("data:")) continue;

          const payload = line.slice(5).trimStart();

          if (payload === "[DONE]") {
            onEvent?.("done");
            onDone?.();
            return;
          }

          // Try OpenAI JSON envelope first; fallback to raw text
          try {
            const json = JSON.parse(payload);
            onEvent?.("openai", json);
            const delta = json?.choices?.[0]?.delta?.content;
            if (typeof delta === "string" && delta.length) onDelta?.(delta);
          } catch {
            onDelta?.(payload);
          }
        }
      }
    }
  } catch (e: any) {
    if (e?.name !== "AbortError") onEvent?.("reader-error", e?.message || String(e));
  } finally {
    onDone?.();
  }
}