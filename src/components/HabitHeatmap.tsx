import type { HeatmapSummary } from "@/lib/heatmap";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY_LABELS = ["Mon", "", "Wed", "", "Fri", "", ""];

/** A year of habit completions, one square per day, like a contribution graph. */
export function HabitHeatmap({ map, today }: { map: HeatmapSummary; today: string }) {
  const monthLabels = map.weeks.map((week, index) => {
    const month = Number(week[0].date.slice(5, 7)) - 1;
    const previous = index > 0 ? Number(map.weeks[index - 1][0].date.slice(5, 7)) - 1 : -1;
    return month !== previous ? MONTHS[month] : "";
  });

  return (
    <div className="stack-sm">
      <div className="heatmap-scroll">
        <div
          className="heatmap"
          role="img"
          aria-label={`Habit activity for the past year: ${map.activeDays} active days, ${map.totalLogs} habits logged, current streak ${map.currentStreak} days.`}
        >
          <div className="heatmap-months" aria-hidden="true">
            {monthLabels.map((label, index) => (
              <span key={index}>{label}</span>
            ))}
          </div>
          <div className="heatmap-days" aria-hidden="true">
            {DAY_LABELS.map((label, index) => (
              <span key={index}>{label}</span>
            ))}
          </div>
          <div className="heatmap-grid" aria-hidden="true">
            {map.weeks.map((week) =>
              week.map((cell) => (
                <span
                  key={cell.date}
                  className={`heat-cell level-${cell.level}${cell.future ? " is-future" : ""}${cell.date === today ? " is-today" : ""}`}
                  title={cell.future ? undefined : `${cell.date}: ${cell.count} habit${cell.count === 1 ? "" : "s"} logged`}
                />
              )),
            )}
          </div>
        </div>
      </div>
      <div className="row-between">
        <span className="faint numeric">
          {map.activeDays} active days · {map.totalLogs} logged · current streak {map.currentStreak} · best {map.longestStreak}
        </span>
        <span className="heatmap-legend faint" aria-hidden="true">
          Less <i className="heat-cell level-0" /> <i className="heat-cell level-1" /> <i className="heat-cell level-2" />{" "}
          <i className="heat-cell level-3" /> <i className="heat-cell level-4" /> More
        </span>
      </div>
    </div>
  );
}
