import { describe, expect, it } from "vitest";
import { supabaseProjectUrl } from "./project-url";

describe("supabaseProjectUrl", () => {
  it("keeps a plain project URL", () => {
    expect(supabaseProjectUrl("https://abc.supabase.co")).toBe("https://abc.supabase.co");
  });

  it("drops an API path pasted from the dashboard", () => {
    expect(supabaseProjectUrl("https://abc.supabase.co/rest/v1/")).toBe("https://abc.supabase.co");
    expect(supabaseProjectUrl("https://abc.supabase.co/auth/v1")).toBe("https://abc.supabase.co");
  });

  it("ignores surrounding spaces and a trailing slash", () => {
    expect(supabaseProjectUrl("  https://abc.supabase.co/  ")).toBe("https://abc.supabase.co");
  });

  it("keeps a local development port", () => {
    expect(supabaseProjectUrl("http://127.0.0.1:54321/")).toBe("http://127.0.0.1:54321");
  });

  it("returns undefined for missing or invalid values", () => {
    expect(supabaseProjectUrl(undefined)).toBeUndefined();
    expect(supabaseProjectUrl("")).toBeUndefined();
    expect(supabaseProjectUrl("not a url")).toBeUndefined();
  });
});
