/**
 * Analytics rules.
 *
 * The database counts rows; this module does the arithmetic a screen adds on top
 * of those rows: totals over a span, relative bar heights and the words for an
 * action-history event. Pure and unit-tested, so "the last 7 days" means exactly
 * the same thing on every screen — and a missing denominator is reported as
 * *unknown*, never quietly rendered as zero.
 */
import type { ActionKind, Database, XpSource } from "@/types/database";

/** One day of the `analytics_range` read model. */
export type AnalyticsDay = Database["public"]["Functions"]["analytics_range"]["Returns"][number];

export const XP_SOURCE_LABELS: Record<XpSource, string> = {
  quest_completion: "Quest completed",
  daily_mission: "Daily mission",
  habit: "Habit logged",
  milestone: "Milestone",
  bonus: "Bonus",
  achievement: "Achievement",
};

export interface RangeTotals {
  days: number;
  xp_awarded: number;
  xp_adjusted: number;
  xp_net: number;
  missions_total: number;
  missions_completed: number;
  missions_skipped: number;
  missions_blocked: number;
  missions_open: number;
  habits_expected: number;
  habits_logged: number;
  steps_completed: number;
  focus_sessions: number;
  focus_completed: number;
  focus_seconds: number;
  achievements_unlocked: number;
}

/** A sum over a set of *real* range rows. Days that were not fetched are not invented. */
export function sumDays(days: readonly AnalyticsDay[]): RangeTotals {
  const totals: RangeTotals = {
    days: 0,
    xp_awarded: 0,
    xp_adjusted: 0,
    xp_net: 0,
    missions_total: 0,
    missions_completed: 0,
    missions_skipped: 0,
    missions_blocked: 0,
    missions_open: 0,
    habits_expected: 0,
    habits_logged: 0,
    steps_completed: 0,
    focus_sessions: 0,
    focus_completed: 0,
    focus_seconds: 0,
    achievements_unlocked: 0,
  };

  for (const day of days) {
    totals.days += 1;
    totals.xp_awarded += day.xp_awarded;
    totals.xp_adjusted += day.xp_adjusted;
    totals.xp_net += day.xp_net;
    totals.missions_total += day.missions_total;
    totals.missions_completed += day.missions_completed;
    totals.missions_skipped += day.missions_skipped;
    totals.missions_blocked += day.missions_blocked;
    totals.missions_open += day.missions_open;
    totals.habits_expected += day.habits_expected;
    totals.habits_logged += day.habits_logged;
    totals.steps_completed += day.steps_completed;
    totals.focus_sessions += day.focus_sessions;
    totals.focus_completed += day.focus_completed;
    totals.focus_seconds += day.focus_seconds;
    totals.achievements_unlocked += day.achievements_unlocked;
  }

  return totals;
}

/**
 * A percentage, or `null` when there is nothing to divide by.
 *
 * `null` is the honest answer for "0 of 0 expected": the screen must say
 * "nothing was scheduled", not "0%", which would accuse the user of missing
 * work that never existed.
 */
export function rate(part: number, whole: number): number | null {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return null;
  return Math.round((part / whole) * 100);
}

export interface TrendBar {
  day: string;
  value: number;
  /** Height relative to the largest positive value in the window, 0–100. */
  percent: number;
  /** True when the day's net is negative (corrections outweighed awards). */
  negative: boolean;
}

/**
 * Bars for a trend row.
 *
 * Heights are relative to the largest *positive* value in the window. A day at
 * or below zero gets no height and is flagged instead: the chart never draws a
 * negative number as if it were a positive one, and the exact value is always
 * available to the label.
 */
export function trendBars(
  days: readonly AnalyticsDay[],
  pick: (day: AnalyticsDay) => number,
): TrendBar[] {
  const values = days.map((day) => {
    const value = pick(day);
    return Number.isFinite(value) ? value : 0;
  });
  const largest = Math.max(1, ...values.filter((value) => value > 0));

  return days.map((day, index) => {
    const value = values[index];
    return {
      day: day.day,
      value,
      percent: value > 0 ? Math.round((value / largest) * 100) : 0,
      negative: value < 0,
    };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readText(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * One sentence for one stored event.
 *
 * Only values that are actually in the row are described. A missing label or a
 * missing field falls back to a shorter, still-true sentence; an unknown kind
 * says exactly that instead of guessing what happened.
 */
export function describeAction(kind: ActionKind | string, detail: unknown, label: string | null): string {
  const context = isRecord(detail) ? detail : {};
  const name = label;

  switch (kind) {
    case "mission_created": {
      const date = readText(context, "mission_date");
      if (name && date) return `Mission “${name}” was created for ${date}.`;
      if (name) return `Mission “${name}” was created.`;
      return date ? `A mission was created for ${date}.` : "A mission was created.";
    }
    case "mission_status_changed": {
      const from = readText(context, "from");
      const to = readText(context, "to");
      if (from && to) {
        return name
          ? `Mission “${name}” moved from ${from} to ${to}.`
          : `A mission moved from ${from} to ${to}.`;
      }
      return name ? `Mission “${name}” changed status.` : "A mission changed status.";
    }
    case "mission_deleted":
      return name ? `Mission “${name}” was deleted.` : "A mission was deleted.";
    case "habit_created":
      return name ? `Habit “${name}” was created.` : "A habit was created.";
    case "habit_logged": {
      const date = readText(context, "log_date");
      if (name && date) return `Habit “${name}” logged for ${date}.`;
      if (name) return `Habit “${name}” logged.`;
      return date ? `A habit was logged for ${date}.` : "A habit was logged.";
    }
    case "habit_unlogged": {
      const date = readText(context, "log_date");
      if (name && date) return `Habit “${name}” recorded as not done for ${date}.`;
      if (name) return `Habit “${name}” recorded as not done.`;
      return date ? `A habit was recorded as not done for ${date}.` : "A habit was recorded as not done.";
    }
    case "habit_archived":
      return name ? `Habit “${name}” archived.` : "A habit was archived.";
    case "habit_restored":
      return name ? `Habit “${name}” restored.` : "A habit was restored.";
    case "habit_deleted":
      return name ? `Habit “${name}” deleted.` : "A habit was deleted.";
    case "time_zone_changed": {
      const from = readText(context, "from");
      const to = readText(context, "to");
      return from && to ? `Time zone changed from ${from} to ${to}.` : "Time zone changed.";
    }
    default:
      return "An event was recorded.";
  }
}
