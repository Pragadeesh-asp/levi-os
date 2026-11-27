"use client";

import { useEffect, useRef, useState } from "react";
import type { SakugaButtonElement } from "@/types/sakuga-vfx";

const STORAGE_KEY = "levi.lastSeenLevel";

function readSeen(): number | null {
  try {
    const value = Number(window.localStorage.getItem(STORAGE_KEY));
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function writeSeen(level: number) {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(level));
  } catch {
    // Private windows can refuse storage; the moment then simply won't repeat-check.
  }
}

/**
 * The one celebratory moment in LEVI OS: when the level the server reports is higher
 * than the last one this browser saw, a full-screen card announces it. The first visit
 * only records the level, so nobody gets a fake level-up on sign-in.
 */
export function LevelUpMoment({ level }: { level: number | null }) {
  const [shown, setShown] = useState<number | null>(null);
  const button = useRef<SakugaButtonElement>(null);

  useEffect(() => {
    if (!level) return;
    const seen = readSeen();
    writeSeen(level);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reacting to a level change reported by the server
    if (seen !== null && level > seen) setShown(level);
  }, [level]);

  useEffect(() => {
    if (shown === null) return;
    const timer = window.setTimeout(() => button.current?.impact?.(), 350);
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" || event.key === "Enter") setShown(null); };
    window.addEventListener("keydown", onKey);
    return () => { window.clearTimeout(timer); window.removeEventListener("keydown", onKey); };
  }, [shown]);

  if (shown === null) return null;
  return (
    <div className="levelup" role="dialog" aria-modal="true" aria-labelledby="levelup-title" onClick={() => setShown(null)}>
      <div className="levelup-card" onClick={(event) => event.stopPropagation()}>
        <p className="eyebrow">level up</p>
        <p className="levelup-number" aria-hidden="true">{shown}</p>
        <h1 id="levelup-title">You reached level {shown}</h1>
        <p className="muted">Every point came from work you actually finished.</p>
        <sakuga-button ref={button} onClick={() => setShown(null)}>Keep going</sakuga-button>
      </div>
    </div>
  );
}
