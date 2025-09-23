export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const file = url.searchParams.get("file") || "";
    const n = Math.max(200, Math.min(20_000, Number(url.searchParams.get("n") || 1200)));

    if (!file) {
      return new Response(JSON.stringify({ ok: false, error: "missing file param" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const path = (await import("node:path")).default;
    const { promises: fs } = await import("node:fs");
    const fpath = path.join(process.cwd(), "kb", file);
    const ext = path.extname(file).toLowerCase();

    let preview = "";

    if (ext === ".pdf") {
      // Light-weight text extraction for preview (same lib you used elsewhere)
      const pdfjs: any = await import("pdfjs-dist/legacy/build/pdf.mjs");
      pdfjs.GlobalWorkerOptions.workerSrc = "pdfjs-dist/legacy/build/pdf.worker.mjs";
      (pdfjs as any).GlobalWorkerOptions.standardFontDataUrl = "pdfjs-dist/legacy/build/";

      const data = new Uint8Array(await fs.readFile(fpath));
      const doc = await pdfjs.getDocument({ data }).promise;
      let out = "";
      for (let pageNo = 1; pageNo <= doc.numPages && out.length < n; pageNo++) {
        const page = await doc.getPage(pageNo);
        const content = await page.getTextContent();
        out += content.items.map((it: any) => it.str).join(" ") + "\n";
      }
      preview = out.slice(0, n);
    } else if ([".txt", ".md", ".html"].includes(ext)) {
      const full = await fs.readFile(fpath, "utf8");
      preview = full.slice(0, n);
    } else {
      return new Response(JSON.stringify({ ok: false, error: "unsupported file type" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ ok: true, file, previewLength: preview.length, preview }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=60",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ ok: false, error: err?.message || String(err) }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
}