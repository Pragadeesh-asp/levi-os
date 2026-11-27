import { addDays, daysBetween, startOfWeek } from "./dates";

/** One day in the habit heatmap. `level` 0 means nothing logged; 1–4 scale with the busiest day. */
export interface HeatCell {
  date: string;
  count: number;
  level: 0 | 1 | 2 | 3 | 4;
  future: boolean;
}

export interface HeatmapSummary {
  /** Columns of Monday→Sunday cells, oldest week first. */
  weeks: HeatCell[][];
  /** Days with at least one completed habit, in the shown range. */
  activeDays: number;
  totalLogs: number;
  /** Consecutive days up to today with at least one habit (today counts if already logged). */
  currentStreak: number;
  longestStreak: number;
  busiestCount: number;
}

/**
 * A year of habit completions laid out like a contribution graph: one column per week,
 * Monday at the top. Only completed logs count; a "not done" log is the same as no log.
 */
export function buildHeatmap(
  logs: readonly { log_date: string; completed: boolean }[],
  today: string,
  weekCount = 53,
): HeatmapSummary {
  const counts = new Map<string, number>();
  for (const log of logs) if (log.completed) counts.set(log.log_date, (counts.get(log.log_date) ?? 0) + 1);

  const first = addDays(startOfWeek(today), -(weekCount - 1) * 7);
  const busiestCount = Math.max(0, ...[...counts].filter(([date]) => date >= first && date <= today).map(([, n]) => n));

  const weeks: HeatCell[][] = [];
  let activeDays = 0;
  let totalLogs = 0;
  let longestStreak = 0;
  let run = 0;
  for (let w = 0; w < weekCount; w++) {
    const column: HeatCell[] = [];
    for (let d = 0; d < 7; d++) {
      const date = addDays(first, w * 7 + d);
      const future = daysBetween(today, date) > 0;
      const count = future ? 0 : (counts.get(date) ?? 0);
      column.push({ date, count, future, level: levelFor(count, busiestCount) });
      if (future) continue;
      totalLogs += count;
      if (count > 0) {
        activeDays += 1;
        run += 1;
        longestStreak = Math.max(longestStreak, run);
      } else run = 0;
    }
    weeks.push(column);
  }

  // Today without a log yet doesn't break the streak; it just hasn't been extended.
  let currentStreak = 0;
  let cursor = (counts.get(today) ?? 0) > 0 ? today : addDays(today, -1);
  while ((counts.get(cursor) ?? 0) > 0 && cursor >= first) {
    currentStreak += 1;
    cursor = addDays(cursor, -1);
  }

  return { weeks, activeDays, totalLogs, currentStreak, longestStreak, busiestCount };
}

function levelFor(count: number, busiest: number): HeatCell["level"] {
  if (count <= 0 || busiest <= 0) return 0;
  const ratio = count / busiest;
  if (ratio <= 0.25) return 1;
  if (ratio <= 0.5) return 2;
  if (ratio <= 0.75) return 3;
  return 4;
}
