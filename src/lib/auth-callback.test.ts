import { describe, expect, it } from "vitest";
import { callbackProblem, signInProblemFromCode, signInProblemMessage } from "./auth-callback";

describe("magic-link callback failures", () => {
  it("treats expired, used and unknown flows as an expired link", () => {
    expect(signInProblemFromCode("otp_expired")).toBe("link_expired");
    expect(signInProblemFromCode("flow_state_expired")).toBe("link_expired");
    expect(signInProblemFromCode("flow_state_not_found")).toBe("link_expired");
  });

  it("explains a missing or mismatched PKCE verifier as a different browser", () => {
    expect(signInProblemFromCode("pkce_code_verifier_not_found")).toBe("different_browser");
    expect(signInProblemFromCode("bad_code_verifier")).toBe("different_browser");
  });

  it("falls back to a generic failure for anything else", () => {
    expect(signInProblemFromCode("over_email_send_rate_limit")).toBe("sign_in_failed");
    expect(signInProblemFromCode(undefined)).toBe("sign_in_failed");
    expect(signInProblemFromCode(null)).toBe("sign_in_failed");
  });

  it("reads Supabase's error query parameters and ignores a clean callback", () => {
    expect(callbackProblem(new URLSearchParams("code=abc"))).toBeNull();
    expect(callbackProblem(new URLSearchParams("error=access_denied&error_code=otp_expired"))).toBe("link_expired");
    expect(callbackProblem(new URLSearchParams("error=server_error"))).toBe("sign_in_failed");
  });

  it("only renders messages for known problems", () => {
    expect(signInProblemMessage("link_expired")).toMatch(/expired/);
    expect(signInProblemMessage(["different_browser", "link_expired"])).toMatch(/different browser/);
    expect(signInProblemMessage("<script>")).toBeNull();
    expect(signInProblemMessage(undefined)).toBeNull();
    expect(signInProblemMessage("")).toBeNull();
  });
});
