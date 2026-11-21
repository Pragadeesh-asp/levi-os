import type { Metadata } from "next";
import { signInProblemMessage } from "@/lib/auth-callback";
import { LoginForm } from "./LoginForm";

export const metadata: Metadata = { title: "Sign in · LEVI OS" };

/**
 * Reads `?problem=` (set by `/auth/callback` when a link fails) on the server, so the
 * explanation is in the first render. Reading search params makes this route dynamic.
 */
export default async function LoginPage({ searchParams }: { searchParams: Promise<{ problem?: string | string[] }> }) {
  const { problem } = await searchParams;
  return <LoginForm notice={signInProblemMessage(problem)} />;
}
