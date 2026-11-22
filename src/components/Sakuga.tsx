"use client";

import Script from "next/script";
import { useEffect, useRef, useState } from "react";
import type { ActionResult } from "@/lib/action-result";
import type { SakugaButtonElement, SakugaToastElement } from "@/types/sakuga-vfx";

/**
 * LEVI OS's use of sakuga-vfx: anime-style reactions on the moments that earn
 * XP. The elements are progressive enhancement: until their scripts load, the
 * page renders ordinary buttons, and prefers-reduced-motion turns the effects off.
 */

const ACHIEVEMENT_EVENT = "levi:achievements";

/** Loads the vendored elements once for the signed-in app. */
export function SakugaScripts() {
  return (
    <>
      <Script src="/sakuga-vfx/button.js" strategy="afterInteractive" />
      <Script src="/sakuga-vfx/toast.js" strategy="afterInteractive" />
    </>
  );
}

function useDefined(tag: string): boolean {
  const [defined, setDefined] = useState(false);
  useEffect(() => {
    let live = true;
    void customElements.whenDefined(tag).then(() => {
      if (live) setDefined(true);
    });
    return () => {
      live = false;
    };
  }, [tag]);
  return defined;
}

/** Announces achievements unlocked by an action; AchievementToast shows them. */
export function celebrate(names: readonly string[]) {
  if (names.length === 0) return;
  window.dispatchEvent(new CustomEvent<string[]>(ACHIEVEMENT_EVENT, { detail: [...names] }));
}

/**
 * A submit button that plays the impact frame (squash, burst, ドン!) when
 * pressed and lands a check once the server action reports success. The click
 * reaction plays either way; the check only appears when the work was saved.
 */
export function ImpactSubmit({
  label,
  result,
  disabled,
  title,
  describedBy,
}: {
  label: string;
  result: ActionResult | null;
  disabled?: boolean;
  title?: string;
  describedBy?: string;
}) {
  const defined = useDefined("sakuga-button");
  const ref = useRef<SakugaButtonElement>(null);

  useEffect(() => {
    if (result?.ok) ref.current?.done();
  }, [result]);

  if (!defined) {
    return (
      <button className="button" type="submit" disabled={disabled} title={title} aria-describedby={describedBy}>
        {label}
      </button>
    );
  }
  return (
    <sakuga-button ref={ref} type="submit" disabled={disabled} title={title} aria-describedby={describedBy}>
      {label}
    </sakuga-button>
  );
}

/** One toast for the whole app: an achievement streaks in, lands in dust, and leaves. */
export function AchievementToast() {
  const ref = useRef<SakugaToastElement>(null);

  useEffect(() => {
    const onAchievements = (event: Event) => {
      const names = (event as CustomEvent<string[]>).detail;
      const toast = ref.current;
      if (!toast || typeof toast.show !== "function") return;
      toast.show(names.length === 1 ? `Unlocked: ${names[0]}` : `Unlocked ${names.length} achievements`);
    };
    window.addEventListener(ACHIEVEMENT_EVENT, onAchievements);
    return () => window.removeEventListener(ACHIEVEMENT_EVENT, onAchievements);
  }, []);

  return <sakuga-toast ref={ref} className="levi-toast" duration="4" />;
}
