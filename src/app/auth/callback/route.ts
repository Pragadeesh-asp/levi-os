import { NextResponse } from "next/server";
import { callbackProblem, signInProblemFromCode, type SignInProblem } from "@/lib/auth-callback";
import { createClient } from "@/lib/supabase/server";

function toLogin(origin: string, problem: SignInProblem) {
  const target = new URL("/login", origin);
  target.searchParams.set("problem", problem);
  return NextResponse.redirect(target);
}

/**
 * Magic-link landing point. A successful exchange goes to the dashboard; a rejected or
 * failed link goes back to `/login` with a reason instead of failing silently.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);

  const reported = callbackProblem(url.searchParams);
  if (reported) return toLogin(url.origin, reported);

  const code = url.searchParams.get("code");
  if (code) {
    const { error } = await (await createClient()).auth.exchangeCodeForSession(code);
    if (error) return toLogin(url.origin, signInProblemFromCode(error.code));
  }
  return NextResponse.redirect(new URL("/dashboard", url.origin));
}
