import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { config, proxy } from "./proxy";

type MockCookie = { name: string; value: string; options?: Record<string, unknown> };

const state = vi.hoisted(() => ({
  clientsCreated: 0,
  getUserCalls: 0,
  user: null as { id: string } | null,
  setAll: null as null | ((cookies: MockCookie[]) => void),
  duringGetUser: null as null | (() => void),
}));

// The real client would talk to Supabase; the fake captures the cookie adapter so
// the test can replay exactly what auth-js does during TOKEN_REFRESHED / SIGNED_OUT.
vi.mock("@supabase/ssr", () => ({
  createServerClient: (
    _url: string,
    _key: string,
    options: {
      cookies: {
        getAll: () => { name: string; value: string }[];
        setAll: (cookies: MockCookie[]) => void;
      };
    },
  ) => {
    state.clientsCreated += 1;
    state.setAll = options.cookies.setAll;
    return {
      auth: {
        getUser: async () => {
          state.getUserCalls += 1;
          state.duringGetUser?.();
          return { data: { user: state.user }, error: state.user ? null : { message: "Auth session missing!" } };
        },
      },
    };
  },
}));

function setCookieHeaderText(response: Response): string {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof headers.getSetCookie === "function") return headers.getSetCookie().join("\n");
  return response.headers.get("set-cookie") ?? "";
}

describe("proxy session refresh", () => {
  beforeEach(() => {
    state.clientsCreated = 0;
    state.getUserCalls = 0;
    state.user = null;
    state.setAll = null;
    state.duringGetUser = null;
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://test-project.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "test-publishable-key");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("passes through without creating a client when Supabase is not configured", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "");

    const response = await proxy(new NextRequest("http://localhost:3000/dashboard"));

    expect(state.clientsCreated).toBe(0);
    expect(state.getUserCalls).toBe(0);
    expect(response.status).toBe(200);
    expect(setCookieHeaderText(response)).toBe("");
  });

  it("validates unauthenticated requests without setting cookies or redirecting", async () => {
    const response = await proxy(new NextRequest("http://localhost:3000/dashboard"));

    expect(state.clientsCreated).toBe(1);
    expect(state.getUserCalls).toBe(1);
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    expect(setCookieHeaderText(response)).toBe("");
  });

  it("leaves an authenticated request untouched when nothing needs refreshing", async () => {
    state.user = { id: "user-1" };

    const response = await proxy(new NextRequest("http://localhost:3000/dashboard"));

    expect(state.getUserCalls).toBe(1);
    expect(setCookieHeaderText(response)).toBe("");
  });

  it("forwards a refreshed session to both the upstream request and the browser", async () => {
    state.user = { id: "user-1" };
    state.duringGetUser = () => {
      state.setAll?.([
        { name: "sb-test-auth-token", value: "new-token", options: { path: "/", maxAge: 400, sameSite: "lax" } },
      ]);
    };
    const request = new NextRequest("http://localhost:3000/dashboard", {
      headers: { cookie: "sb-test-auth-token=old-token; kept=value" },
    });

    const response = await proxy(request);

    // The page rendered below sees the rotated session…
    expect(request.cookies.get("sb-test-auth-token")?.value).toBe("new-token");
    expect(request.cookies.get("kept")?.value).toBe("value");
    // …and the browser is told to store it through Set-Cookie.
    expect(setCookieHeaderText(response)).toContain("sb-test-auth-token=new-token");
    expect(response.headers.get("location")).toBeNull();
  });

  it("propagates rotation cleanup cookies (Max-Age=0)", async () => {
    state.user = { id: "user-1" };
    state.duringGetUser = () => {
      state.setAll?.([{ name: "sb-test-auth-token.1", value: "", options: { path: "/", maxAge: 0 } }]);
    };

    const response = await proxy(
      new NextRequest("http://localhost:3000/dashboard", { headers: { cookie: "sb-test-auth-token.1=stale" } }),
    );

    expect(setCookieHeaderText(response)).toMatch(/sb-test-auth-token\.1=.*max-age=0/i);
  });
});

describe("proxy matcher", () => {
  it("runs on app pages and the auth routes", () => {
    for (const url of ["/", "/dashboard", "/review?date=2026-10-18", "/login", "/auth/callback?code=abc", "/auth/signout"]) {
      expect(unstable_doesMiddlewareMatch({ config, url }), url).toBe(true);
    }
  });

  it("skips static files, the image optimizer and icons", () => {
    for (const url of ["/_next/static/chunks/main.js", "/_next/image?url=%2Fphoto.png&w=64", "/favicon.ico", "/photo.png", "/logo.svg"]) {
      expect(unstable_doesMiddlewareMatch({ config, url }), url).toBe(false);
    }
  });
});
