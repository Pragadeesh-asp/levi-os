import { describe, expect, it } from "vitest";
import { describeAction, rate, sumDays, trendBars, type AnalyticsDay } from "./analytics";

function makeDay(day: string, overrides: Partial<AnalyticsDay> = {}): AnalyticsDay {
  return {
    day,
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
    ...overrides,
  };
}

const ZERO_TOTALS = {
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

describe("analytics totals", () => {
  it("sums every column over the days it was actually given", () => {
    const totals = sumDays([
      makeDay("2026-10-17", {
        xp_awarded: 50,
        xp_adjusted: -20,
        xp_net: 30,
        missions_total: 3,
        missions_completed: 2,
        missions_open: 1,
        habits_expected: 2,
        habits_logged: 1,
        steps_completed: 1,
        focus_sessions: 1,
        focus_completed: 1,
        focus_seconds: 600,
        achievements_unlocked: 1,
      }),
      makeDay("2026-10-18", {
        xp_awarded: 20,
        xp_net: 20,
        missions_total: 1,
        missions_completed: 1,
        habits_expected: 1,
        habits_logged: 1,
      }),
    ]);

    expect(totals).toEqual({
      days: 2,
      xp_awarded: 70,
      xp_adjusted: -20,
      xp_net: 50,
      missions_total: 4,
      missions_completed: 3,
      missions_skipped: 0,
      missions_blocked: 0,
      missions_open: 1,
      habits_expected: 3,
      habits_logged: 2,
      steps_completed: 1,
      focus_sessions: 1,
      focus_completed: 1,
      focus_seconds: 600,
      achievements_unlocked: 1,
    });
  });

  it("does not invent a day that was not fetched", () => {
    expect(sumDays([])).toEqual(ZERO_TOTALS);
  });
});

describe("rate", () => {
  it("returns null when there is no denominator", () => {
    expect(rate(0, 0)).toBeNull();
    expect(rate(3, 0)).toBeNull();
    expect(rate(Number.NaN, 4)).toBeNull();
  });

  it("rounds a real rate to whole percent", () => {
    expect(rate(1, 3)).toBe(33);
    expect(rate(2, 3)).toBe(67);
    expect(rate(2, 2)).toBe(100);
  });
});

describe("trend bars", () => {
  it("scales heights to the largest positive net and flags negative days", () => {
    const bars = trendBars(
      [
        makeDay("a", { xp_net: 10 }),
        makeDay("b", { xp_net: 40 }),
        makeDay("c", { xp_net: 0 }),
        makeDay("d", { xp_net: -15 }),
      ],
      (day) => day.xp_net,
    );

    expect(bars.map((bar) => bar.percent)).toEqual([25, 100, 0, 0]);
    expect(bars.map((bar) => bar.negative)).toEqual([false, false, false, true]);
    expect(bars.map((bar) => bar.value)).toEqual([10, 40, 0, -15]);
  });

  it("handles an empty window and an all-zero window without dividing by zero", () => {
    expect(trendBars([], (day) => day.xp_net)).toEqual([]);
    expect(
      trendBars([makeDay("a"), makeDay("b")], (day) => day.xp_net).map((bar) => bar.percent),
    ).toEqual([0, 0]);
  });

  it("can chart another metric without special cases", () => {
    const bars = trendBars(
      [makeDay("a", { missions_completed: 1 }), makeDay("b", { missions_completed: 2 })],
      (day) => day.missions_completed,
    );
    expect(bars.map((bar) => bar.percent)).toEqual([50, 100]);
  });
});

describe("action history sentences", () => {
  it("describes a mission creation with its planned date", () => {
    expect(
      describeAction("mission_created", { mission_date: "2026-10-18", status: "planned" }, "Ship the audit"),
    ).toBe("Mission “Ship the audit” was created for 2026-10-18.");
  });

  it("describes a real transition from the stored values", () => {
    expect(
      describeAction("mission_status_changed", { from: "active", to: "completed" }, "Ship the audit"),
    ).toBe("Mission “Ship the audit” moved from active to completed.");
  });

  it("describes a habit correction with the day it belongs to", () => {
    expect(describeAction("habit_unlogged", { log_date: "2026-10-17" }, "Read")).toBe(
      "Habit “Read” recorded as not done for 2026-10-17.",
    );
  });

  it("describes a time-zone change with both zones", () => {
    expect(describeAction("time_zone_changed", { from: "UTC", to: "Asia/Kolkata" }, null)).toBe(
      "Time zone changed from UTC to Asia/Kolkata.",
    );
  });

  it("falls back without inventing a name or a value", () => {
    expect(describeAction("mission_deleted", {}, null)).toBe("A mission was deleted.");
    expect(describeAction("mission_status_changed", {}, "Renamed")).toBe(
      "Mission “Renamed” changed status.",
    );
    expect(describeAction("habit_logged", null, null)).toBe("A habit was logged.");
  });

  it("says only that an event was recorded when the kind is unknown", () => {
    expect(describeAction("future_event", { secret: "not shown" }, null)).toBe("An event was recorded.");
  });

  it("ignores malformed detail instead of throwing", () => {
    expect(() => describeAction("mission_created", "not-json" as unknown, null)).not.toThrow();
    expect(describeAction("mission_created", ["array"] as unknown, "X")).toBe("Mission “X” was created.");
  });
});
