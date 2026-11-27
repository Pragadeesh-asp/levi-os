import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import type { Database } from "@/types/database";
import { supabaseProjectUrl } from "./lib/supabase/project-url";

/**
 * Session refresh at the network boundary — Next 16's renamed middleware file.
 *
 * `@supabase/ssr` needs a middleware-style hook to keep sessions alive: Server
 * Components cannot write cookies, so a token refresh that happens while a page
 * renders would be discarded. Before every matched request this proxy:
 *
 * 1. reads the session from the request cookies;
 * 2. validates it with `getUser()`, which also refreshes the access token when it
 *    is inside the expiry margin — that refresh is what makes `setAll` run;
 * 3. forwards the refreshed cookies on the request (so the page below already sees
 *    the new session) and sends them to the browser via `Set-Cookie` on the response.
 *
 * Deliberately no redirects here: signed-in state is still decided by the pages and
 * the app layout, and the magic-link callback (`/auth/callback`) must keep working.
 */
export async function proxy(request: NextRequest) {
  const url = supabaseProjectUrl(process.env.NEXT_PUBLIC_SUPABASE_URL);
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  // Without configuration the app renders its setup notice; never fail every request.
  if (!url || !key) return NextResponse.next();

  let response = NextResponse.next({ request });

  const supabase = createServerClient<Database>(url, key, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (cookiesToSet) => {
        for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) response.cookies.set(name, value, options);
      },
    },
  });

  // Do not run anything between creating the client and this call: validating the
  // user here is what triggers the refresh and the cookie propagation above.
  await supabase.auth.getUser();

  return response;
}

export const config = {
  matcher: [
    /*
     * Every route except static assets and images, so pages, route handlers
     * (the magic-link callback and sign-out) and Server Functions all get refresh.
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
