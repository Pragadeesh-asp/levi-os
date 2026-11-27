"use server";

import { revalidateStats, requireUser, runAchievementSweep } from "@/lib/auth";
import { failure, success, type ActionResult } from "@/lib/action-result";
import { cleanMissionDate, cleanMissionTitle } from "@/lib/input-validation";

/**
 * Sets next week's three missions from the weekly review. Each non-empty title becomes a
 * high-priority mission on next Monday, through the same `create_mission` RPC the
 * Missions screen uses, so it gets the same validation and ordering.
 */
export async function planNextWeek(_state: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const { supabase } = await requireUser();
    const missionDate = cleanMissionDate(formData.get("missionDate"), "Next week's start");
    const titles = ["first", "second", "third"]
      .map((name) => formData.get(name))
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .map((value) => cleanMissionTitle(value));
    if (titles.length === 0) throw new Error("Write at least one mission for next week.");

    for (const title of titles) {
      const { error } = await supabase.rpc("create_mission", {
        p_mission_date: missionDate,
        p_title: title,
        p_priority: "high",
        p_estimate_minutes: null,
        p_success_criteria: null,
        p_quest_id: null,
        p_notes: "Set in the weekly review.",
      });
      if (error) throw new Error(error.message);
    }

    revalidateStats();
    const unlocked = await runAchievementSweep(supabase);
    return success(`${titles.length} mission${titles.length === 1 ? "" : "s"} set for ${missionDate}.`, unlocked);
  } catch (error) {
    return failure(error, "Next week's missions could not be saved.");
  }
}
