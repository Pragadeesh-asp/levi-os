"use client";

import { useEffect } from "react";
import { Panel } from "@/components/ui";

/**
 * Error boundary for every signed-in module.
 *
 * It never shows raw database text to the user; the digest is surfaced so the exact
 * failure can be matched to the server log, and retry() re-runs the failed segment
 * without a full reload.
 */
export default function AppError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error("LEVI OS module error:", error);
  }, [error]);

  // "Could not find the table/function … in the schema cache" means the database is
  // missing migrations, not that the page is broken. Say so, and say how to fix it.
  if (/in the schema cache/i.test(error.message)) {
    return (
      <Panel>
        <div className="stack-sm">
          <p className="eyebrow">Database update needed</p>
          <h1>Your database is behind the app</h1>
          <p className="muted">
            This screen needs tables that your Supabase project doesn&apos;t have yet. The app code is fine and none of
            your data is lost: the database only needs the updates listed in{" "}
            <code>docs/REMOTE_DEPLOYMENT_RUNBOOK.md</code> (seven migrations, applied in order, after a backup).
          </p>
          <p className="faint">Details: {error.message}</p>
          <div className="row">
            <button className="button" type="button" onClick={() => retry()}>
              Try again
            </button>
          </div>
        </div>
      </Panel>
    );
  }

  return (
    <Panel>
      <div className="stack-sm">
        <p className="eyebrow">Something broke</p>
        <h1>This screen could not load</h1>
        <p className="muted">
          Nothing you saved was lost. The page failed while reading or rendering your data, so it can simply be
          retried.
        </p>
        <div className="row">
          <button className="button" type="button" onClick={() => retry()}>
            Try again
          </button>
          <a className="button secondary" href="/dashboard">
            Back to Today
          </a>
        </div>
        {error.digest ? <p className="faint">Reference: {error.digest}</p> : null}
      </div>
    </Panel>
  );
}
