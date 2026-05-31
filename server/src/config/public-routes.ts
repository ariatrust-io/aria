/**
 * SINGLE SOURCE OF TRUTH for which path prefixes the public membrane forwards
 * to the internal API. The membrane is default-deny: anything NOT listed here
 * is rejected with 404 before it ever reaches the internal server.
 *
 * Adding an entry here is a DELIBERATE security decision to expose that path
 * publicly. Keep it that way — do not auto-derive this from the router.
 *
 * Both `membrane.ts` (to build its allowlist) and the guardrail test
 * (`tests/membrane.test.ts`) import from this file, so the allowlist can never
 * silently diverge across files.
 */
export const PUBLIC_PATHS = [
  // ── Pages (served by index.ts from /public) ──
  "/",
  "/app",
  "/privacy",
  "/terms",
  "/acceptable-use",
  "/cookies",
  "/docs",
  "/pricing",
  "/proof",
  "/reset-password",
  "/health",
  // ── API ──
  "/v1/setup",
  "/v1/agents",
  "/v1/events",
  "/v1/auth",
  "/v1/api-keys",
  "/v1/webhooks",
  "/v1/gate",
  "/v1/witness",
  "/v1/temporal",
  "/v1/zeroproof",
  "/v1/admin",
  "/v1/billing",
  "/v1/proof",
] as const;

/**
 * Precise allowlist match: a request path is public only if it EXACTLY equals
 * an allowed prefix, or is a sub-path beneath it ("<prefix>/...").
 *
 * This is deliberately stricter than a bare `startsWith(prefix)`: that would
 * let "/proofXYZ" through on the back of "/proof". With the "/" boundary,
 * "/proof" allows "/proof" and "/proof/public/stats" but NOT "/proofXYZ".
 * "/" is special-cased to an exact match so it never matches everything.
 */
export function isPublicPath(reqPath: string): boolean {
  return PUBLIC_PATHS.some((p) =>
    p === "/" ? reqPath === "/" : reqPath === p || reqPath.startsWith(p + "/")
  );
}
