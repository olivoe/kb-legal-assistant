/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextRequest } from "next/server";

export async function GET(_req: NextRequest) {
  try {
    const url = process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;

    if (!url || !token) {
      return Response.json(
        { ok: false, reason: "Missing UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN" },
        { status: 500 }
      );
    }

    // Lazy import to avoid bundling in edge
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Redis } = require("@upstash/redis");
    const redis = new Redis({ url, token });

    const key = `kb-selftest:${Date.now()}`;
    const payload = { msg: "hello", t: Date.now() };

    const setRes = await redis.set(key, JSON.stringify(payload), { ex: 60 });
    const getRes = await redis.get<string>(key);
    const delRes = await redis.del(key);

    return Response.json({
      ok: true,
      setRes,                 // usually "OK"
      readBack: getRes,       // should be the JSON string
      parsed: (() => { try { return JSON.parse(getRes ?? "null"); } catch { return null; } })(),
      delRes,                 // number of keys deleted
      envPresent: Boolean(url && token),
    });
  } catch (err: any) {
    return Response.json(
      { ok: false, error: err?.message || String(err) },
      { status: 500 }
    );
  }
}