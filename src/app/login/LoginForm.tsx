"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

/** Magic-link request form. `notice` explains why a previous link did not sign you in. */
export function LoginForm({ notice }: { notice: string | null }) {
  const [email, setEmail] = useState(""); const [message, setMessage] = useState("");
  async function signIn(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      const { error } = await createClient().auth.signInWithOtp({ email, options: { emailRedirectTo: `${location.origin}/auth/callback` } });
      setMessage(error ? error.message : "Check your email for your secure sign-in link. Open it in this same browser.");
    } catch { setMessage("Supabase is not configured yet. Add the variables from .env.example."); }
  }
  return <main className="shell" style={{ maxWidth: 500, paddingTop: 100 }}><section className="panel"><p className="eyebrow">Authentication</p><h1>Enter LEVI OS</h1>{notice && <p className="notice error" role="alert" style={{ marginTop: 12 }}>{notice}</p>}<form onSubmit={signIn} style={{ marginTop: 16 }}><label htmlFor="email">Email</label><input id="email" type="email" required value={email} onChange={(event) => setEmail(event.target.value)} style={{ width: "100%", margin: "8px 0 16px", padding: 12, borderRadius: 8 }} /><button className="button" type="submit">Send secure link</button></form>{message && <p className="muted" role="status">{message}</p>}</section></main>;
}
