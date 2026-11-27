/**
 * The Supabase project URL as the client libraries expect it: scheme and host only.
 *
 * Supabase's dashboard also shows API addresses such as `https://<ref>.supabase.co/rest/v1/`.
 * Pasting one of those as the project URL makes every auth request go to
 * `/rest/v1/auth/v1/...`, which Supabase rejects with "Invalid path specified in request URL".
 * Returns undefined for a missing or unparsable value so callers keep their own checks.
 */
export function supabaseProjectUrl(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}
