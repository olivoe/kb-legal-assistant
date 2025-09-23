type Req = "OPENAI_API_KEY" | "SUPABASE_URL" | "SUPABASE_SERVICE_ROLE_KEY";

function missing(keys: string[]) {
  return keys.filter((k) => !process.env[k] || String(process.env[k]).trim() === "");
}

export function requireEnv(keys: Req[]) {
  const miss = missing(keys);
  if (miss.length) {
    // Throw a readable error early (visible in dev logs and 500s)
    throw new Error(`Missing required env var(s): ${miss.join(", ")}`);
  }
  // Return a typed object for convenience
  return {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY!,
    SUPABASE_URL: process.env.SUPABASE_URL!,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY!,
  };
}
