"use server";

import { revalidateFocus, requireUser } from "@/lib/auth";
import { failure, success, type ActionResult } from "@/lib/action-result";
import { formatDuration } from "@/lib/focus";
import { cleanBoolean, cleanFocusIntent, cleanId, cleanOptionalId } from "@/lib/input-validation";

/**
 * Focus sessions.
 *
 * Both writes are one RPC call: the database owns the timestamps, the "at most one
 * running session" rule and the duration, and it awards no XP for any of it. These
 * actions only validate what the browser sent and turn the returned row into a
 * sentence — they never compute a duration themselves.
 */

export async function startFocus(_state: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const { supabase } = await requireUser();
    const intent = cleanFocusIntent(formData.get("intent"));
    const missionId = cleanOptionalId(formData.get("missionId"), "A mission");

    const { data, error } = await supabase.rpc("start_focus_session", {
      p_intent: intent,
      p_mission_id: missionId,
    });
    if (error) throw new Error(error.message);
    if (!data) throw new Error("The database did not return the new focus session.");

    revalidateFocus();
    return success(`Focusing on “${intent}”. The timer runs on the database clock.`);
  } catch (error) {
    return failure(error, "The focus session could not be started.");
  }
}

export async function endFocus(_state: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const { supabase } = await requireUser();
    const sessionId = cleanId(formData.get("sessionId"), "A focus session");
    const discard = cleanBoolean(formData.get("discard"));

    const { data, error } = await supabase.rpc("end_focus_session", {
      p_session_id: sessionId,
      p_discard: discard,
    });
    if (error) throw new Error(error.message);
    const row = (data ?? [])[0];
    if (!row) throw new Error("The database did not return the ended focus session.");

    revalidateFocus();
    if (row.already_ended) {
      return success("That session had already ended — nothing was changed.");
    }
    const reported = formatDuration(row.elapsed_seconds);
    return discard
      ? success(`Session discarded — ${reported} stays in the record but is not counted as focus.`)
      : success(`Session ended — ${reported} of focus recorded. No XP: minutes on a clock are not an outcome.`);
  } catch (error) {
    return failure(error, "The focus session could not be ended.");
  }
}
