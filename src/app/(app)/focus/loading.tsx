import { Panel } from "@/components/ui";

/**
 * Route-level fallback for Focus. It mirrors the panel shape of the real page so the
 * layout does not jump when the sessions arrive.
 */
export default function FocusLoading() {
  return (
    <div className="stack" aria-busy="true" aria-live="polite" style={{ gap: 18 }}>
      <span className="sr-only">Loading your focus sessions…</span>
      <div className="stack-sm">
        <span className="skeleton" style={{ width: "5rem", height: "0.7rem" }} />
        <span className="skeleton" style={{ width: "16rem", height: "1.6rem" }} />
      </div>
      <Panel>
        <div className="stack-sm">
          <span className="skeleton" style={{ width: "30%" }} />
          <span className="skeleton" style={{ width: "55%", height: "1.4rem" }} />
          <span className="skeleton" style={{ width: "100%" }} />
        </div>
      </Panel>
      <div className="grid">
        {[0, 1, 2].map((key) => (
          <Panel key={key}>
            <div className="stack-sm">
              <span className="skeleton" style={{ width: "40%" }} />
              <span className="skeleton" style={{ width: "65%", height: "1.6rem" }} />
            </div>
          </Panel>
        ))}
      </div>
      <Panel>
        <div className="stack-sm">
          <span className="skeleton" style={{ width: "30%" }} />
          <span className="skeleton" style={{ width: "100%" }} />
          <span className="skeleton" style={{ width: "80%" }} />
        </div>
      </Panel>
    </div>
  );
}
