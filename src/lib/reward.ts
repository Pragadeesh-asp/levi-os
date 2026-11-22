import type { ActionResult } from "@/lib/action-result";

/** The window event AchievementToast listens for. */
export const ACHIEVEMENT_EVENT = "levi:achievements";

/** How long a saved action holds the screen so its check visibly lands first. */
export const CHECK_BEAT_MS = 450;

/** The one method of a sakuga-button the reward uses. */
export interface CheckTarget {
  done(hold?: number): void;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Announces achievements unlocked by an action; AchievementToast shows them. */
export function celebrate(names: readonly string[]) {
  if (names.length === 0) return;
  window.dispatchEvent(new CustomEvent<string[]>(ACHIEVEMENT_EVENT, { detail: [...names] }));
}

/**
 * Plays the reward for a saved action: the toast for unlocked achievements and the
 * check on the impact button that was pressed.
 *
 * Call it from inside the action, before React commits the result. Completing a
 * mission swaps its Complete button for Reopen in that same commit, so an effect in
 * the button's form would never run. React 19 commits the updates made during an
 * action together once the action settles, so awaiting a short beat lets the check
 * land before the card changes; with reduced motion there is nothing to wait for.
 * The reward is cosmetic: it never turns a saved action into an error.
 */
export async function reward(
  result: ActionResult,
  button: CheckTarget | null,
  wait: (ms: number) => Promise<void> = sleep,
): Promise<void> {
  if (!result.ok) return;
  try {
    if (result.unlocked?.length) celebrate(result.unlocked);
    if (!button || typeof button.done !== "function") return;
    button.done();
    if (!prefersReducedMotion()) await wait(CHECK_BEAT_MS);
  } catch {
    // An effect that fails leaves the saved result exactly as the server returned it.
  }
}
