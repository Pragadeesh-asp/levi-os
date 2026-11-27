import { describe, expect, it } from "vitest";
import { buildHeatmap } from "./heatmap";

const done = (log_date: string, times = 1) => Array.from({ length: times }, () => ({ log_date, completed: true }));

describe("buildHeatmap", () => {
  // 2026-11-28 is a Saturday.
  const today = "2026-11-28";

  it("lays out Monday-first weeks ending with the current week", () => {
    const map = buildHeatmap([], today, 2);
    expect(map.weeks).toHaveLength(2);
    expect(map.weeks[1][0].date).toBe("2026-11-23");
    expect(map.weeks[1][5].date).toBe(today);
    expect(map.weeks[1][6]).toMatchObject({ date: "2026-11-29", future: true, count: 0 });
    expect(map.weeks[0][0].date).toBe("2026-11-16");
  });

  it("counts only completed logs and scales levels to the busiest day", () => {
    const map = buildHeatmap([...done("2026-11-27", 4), ...done("2026-11-26"), { log_date: "2026-11-25", completed: false }], today, 1);
    const byDate = Object.fromEntries(map.weeks[0].map((cell) => [cell.date, cell]));
    expect(byDate["2026-11-27"]).toMatchObject({ count: 4, level: 4 });
    expect(byDate["2026-11-26"]).toMatchObject({ count: 1, level: 1 });
    expect(byDate["2026-11-25"]).toMatchObject({ count: 0, level: 0 });
    expect(map.totalLogs).toBe(5);
    expect(map.activeDays).toBe(2);
  });

  it("keeps the streak alive when today has no log yet", () => {
    const map = buildHeatmap([...done("2026-11-25"), ...done("2026-11-26"), ...done("2026-11-27")], today, 2);
    expect(map.currentStreak).toBe(3);
    expect(map.longestStreak).toBe(3);
  });

  it("counts today once it is logged, and resets after a gap", () => {
    const map = buildHeatmap([...done("2026-11-20"), ...done("2026-11-21"), ...done("2026-11-27"), ...done(today)], today, 2);
    expect(map.currentStreak).toBe(2);
    expect(map.longestStreak).toBe(2);
  });

  it("ignores logs outside the shown range", () => {
    const map = buildHeatmap(done("2025-01-01", 9), today, 2);
    expect(map.totalLogs).toBe(0);
    expect(map.busiestCount).toBe(0);
  });
});
