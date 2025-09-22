// lib/cache.ts
import { createHash } from "crypto";
import { Redis } from "@upstash/redis";

export type CacheRecord = {
  v: 1;
  createdAt: number;
  model: string;
  query: string;
  queryCanon: string;
  filesDigest: string;
  answer: string;
  source: "sse";
};

export const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

export function canonicalizeQuery(q: string) {
  return q.trim().replace(/\s+/g, " ").toLowerCase();
}

export function digestFiles(paths: string[]) {
  const sorted = Array.from(new Set(paths)).sort();
  const h = createHash("sha1");
  h.update(sorted.join("\n"));
  return h.digest("hex");
}

export function makeKeys(queryCanon: string, filesDigest: string) {
  const base = `v1:${queryCanon}:${filesDigest}`;
  return {
    primary: `req:${base}`,     // specific to query+files
    stable:  `files:${filesDigest}`, // reusable for the same file set
  };
}

export async function readCache(query: string, files: string[]) {
  const queryCanon = canonicalizeQuery(query);
  const filesDigest = digestFiles(files);
  const { primary, stable } = makeKeys(queryCanon, filesDigest);

  const [hitPrimary, hitStable] = await redis.mget<string | null>(primary, stable);
  const hit = hitPrimary ?? hitStable;
  return {
    hitKey: hit ? (hitPrimary ? primary : stable) : null,
    record: hit ? (JSON.parse(hit) as CacheRecord) : null,
    meta: { primary, stable, queryCanon, filesDigest },
  };
}

export async function writeCache(
  record: Omit<CacheRecord, "v" | "createdAt">,
  keys: { primary: string; stable: string },
  ttlSec = 60 * 60 * 24
) {
  const full: CacheRecord = { v: 1, createdAt: Date.now(), ...record };
  const payload = JSON.stringify(full);
  await redis
    .pipeline()
    .setex(keys.primary, ttlSec, payload)
    .setex(keys.stable, ttlSec, payload)
    .exec();
  return full;
}