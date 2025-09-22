// test-sse.js
import fetch from "node-fetch";

const url = "http://localhost:3005/api/chat?stream=1&nocache=1";

async function run() {
  console.log("🔗 Connecting to SSE stream:", url);

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "que dice el articulo 123 del codigo procesal?" }),
  });

  if (!res.ok || !res.body) {
    console.error("❌ Failed to connect:", res.status, res.statusText);
    return;
  }

  // Read Node.js stream chunk by chunk
  for await (const chunk of res.body) {
    const text = chunk.toString("utf8");
    process.stdout.write(text); // write directly to console
  }
}

run().catch((err) => console.error("❌ Error:", err));