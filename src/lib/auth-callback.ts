/**
 * Explaining a failed magic-link sign-in.
 *
 * `/auth/callback` used to ignore failures and send everyone to `/dashboard`, where a
 * signed-out visitor just saw the sign-in panel again with no reason. The callback now
 * maps the failure to one of three plain explanations and passes it to `/login` as
 * `?problem=…`; the login page renders the matching message.
 *
 * The codes are Supabase Auth error codes. A missing PKCE code verifier is the classic
 * case for LEVI: the link was requested in one browser (for example a LEVI Browser
 * Space) and opened in another (the mail app's browser), so the verifier cookie that
 * proves the request came from this browser is not there.
 */

export const SIGN_IN_PROBLEMS = ["link_expired", "different_browser", "sign_in_failed"] as const;

export type SignInProblem = (typeof SIGN_IN_PROBLEMS)[number];

const MESSAGES: Record<SignInProblem, string> = {
  link_expired: "That sign-in link has expired or was already used. Send yourself a new one below.",
  different_browser:
    "That link was opened in a different browser from the one that asked for it, or a newer link replaced it. Open the latest email in the same browser, or send a new link below.",
  sign_in_failed: "Sign-in didn't finish. Send yourself a new link below.",
};

/** Maps a Supabase Auth error code to the explanation shown on the login page. */
export function signInProblemFromCode(code: string | null | undefined): SignInProblem {
  switch (code) {
    case "otp_expired":
    case "flow_state_expired":
    case "flow_state_not_found":
      return "link_expired";
    case "pkce_code_verifier_not_found":
    case "bad_code_verifier":
      return "different_browser";
    default:
      return "sign_in_failed";
  }
}

/**
 * Supabase reports a rejected link on the callback URL as `error` / `error_code` query
 * parameters. Returns `null` when the callback carries no error.
 */
export function callbackProblem(params: URLSearchParams): SignInProblem | null {
  if (!params.has("error") && !params.has("error_code")) return null;
  return signInProblemFromCode(params.get("error_code"));
}

function isSignInProblem(value: string): value is SignInProblem {
  return (SIGN_IN_PROBLEMS as readonly string[]).includes(value);
}

/** The message for a `?problem=` value, or `null` for a missing or unknown value. */
export function signInProblemMessage(value: string | string[] | undefined): string | null {
  const first = Array.isArray(value) ? value[0] : value;
  return first && isSignInProblem(first) ? MESSAGES[first] : null;
}
