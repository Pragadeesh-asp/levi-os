"use client";

import Script from "next/script";
import { useEffect, useRef, useState } from "react";
import type { Ref } from "react";
import { ACHIEVEMENT_EVENT } from "@/lib/reward";
import type { SakugaButtonElement, SakugaToastElement } from "@/types/sakuga-vfx";

/**
 * LEVI OS's use of sakuga-vfx: anime-style reactions on the moments that earn
 * XP. The elements are progressive enhancement: until their scripts load, the
 * page renders ordinary buttons, and prefers-reduced-motion turns the effects off.
 * The reward itself (the check and the toast) is played by reward() in lib/reward.ts.
 */

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

/**
 * A submit button that plays the impact frame (squash, burst, ドン!) when pressed.
 * ActionForm holds its ref and lands the check through reward() once the server
 * action reports success. While the action saves, the button is disabled and marked
 * `data-saving`, which globals.css uses to keep the impact at full strength.
 */
export function ImpactSubmit({
  ref,
  label,
  pendingLabel,
  pending = false,
  disabled,
  title,
  describedBy,
}: {
  ref?: Ref<SakugaButtonElement>;
  label: string;
  /** Shown by the plain fallback while saving; the animated button keeps its label. */
  pendingLabel?: string;
  pending?: boolean;
  disabled?: boolean;
  title?: string;
  describedBy?: string;
}) {
  const defined = useDefined("sakuga-button");

  if (!defined) {
    return (
      <button className="button" type="submit" disabled={pending || disabled} title={title} aria-describedby={describedBy}>
        {pending ? (pendingLabel ?? label) : label}
      </button>
    );
  }
  return (
    <sakuga-button
      ref={ref}
      type="submit"
      disabled={pending || disabled}
      data-saving={pending ? "" : undefined}
      title={title}
      aria-describedby={describedBy}
    >
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
