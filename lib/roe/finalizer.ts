// lib/roe/finalizer.ts
export type FinalizeOpts = {
  injectDisclaimer?: boolean;          // ask to prepend disclaimer
  disclaimerAlreadyShown?: boolean;    // don't duplicate banner if already shown this session
  uncertainty?: boolean;               // if confidence too low
  maxSentences?: number;               // default 6
  minSentences?: number;               // default 3 (soft target; we won't pad)
};

const DISCLAIMER =
  "Esta IA puede cometer errores; use la información de forma referencial y contáctenos ante cualquier duda.";

export function roeFinalize(raw: string, opts: FinalizeOpts = {}) {
  const {
    injectDisclaimer = false,
    disclaimerAlreadyShown = false,
    uncertainty = false,
    maxSentences = 6,
  } = opts;

  let text = (raw ?? "").trim();

  // Trim to <= maxSentences (simple guard; don’t synthesize extra content)
  const sentences = text.split(/(?<=[.?!])\s+/).filter(Boolean);
  if (sentences.length > maxSentences) {
    text = sentences.slice(0, maxSentences).join(" ");
  }

  // Append uncertainty phrase per RoE
  if (uncertainty) {
    text += (/[.?!]\s*$/.test(text) ? "" : ".") + " Respuesta incierta. Contáctenos.";
  }

  // One-time disclaimer (prepend)
  const shouldPrepend = injectDisclaimer && !disclaimerAlreadyShown;
  const finalText = shouldPrepend ? `${DISCLAIMER}\n\n${text}` : text;

  return {
    text: finalText,
    disclaimerInjected: shouldPrepend,
  };
}

/**
 * Helper to set a simple session cookie flag after injecting the disclaimer once.
 * Use it server-side when responding to the client.
 */
export function setDisclaimerCookieHeader(): Record<string, string> {
  const cookie =
    "roe_disclaimer_shown=1; Path=/; Max-Age=604800; SameSite=Lax"; // 7 days
  return { "Set-Cookie": cookie };
}