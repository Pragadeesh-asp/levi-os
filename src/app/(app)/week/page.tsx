import type { Metadata } from "next";
import { ActionForm } from "@/components/ActionForm";
import { Badge, ConfigurationNotice, EmptyState, Field, PageHeader, Panel, SignedOutState, StatTile } from "@/components/ui";
import { rate, sumDays } from "@/lib/analytics";
import { addDays, isoWeekday, startOfWeek } from "@/lib/dates";
import { formatDuration } from "@/lib/focus";
import { getAnalyticsRange, getMissionsBetween, getSessionContext, isSupabaseConfigured } from "@/lib/queries";
import { formatXp } from "@/lib/utils";
import { planNextWeek } from "./actions";

export const metadata: Metadata = { title: "Week · LEVI OS" };

/**
 * The weekly review: what this week (Monday to today) actually produced, from the same
 * records as the Today screen, and three missions for next week. Best done on Sunday.
 */
export default async function WeekPage() {
  if (!isSupabaseConfigured()) return <ConfigurationNotice />;
  const session = await getSessionContext();
  if (!session) return <SignedOutState module="Week" />;
  const { supabase, today, timeZone } = session;

  const weekStart = startOfWeek(today);
  const nextMonday = addDays(weekStart, 7);
  const [range, missions] = await Promise.all([
    getAnalyticsRange(supabase, weekStart, today, timeZone),
    getMissionsBetween(supabase, weekStart, today),
  ]);
  const week = sumDays(range);
  const wins = missions.filter((mission) => mission.status === "completed");
  const misses = missions.filter((mission) => mission.status === "skipped" || mission.status === "blocked" || (mission.status !== "completed" && mission.mission_date < today));
  const isSunday = isoWeekday(today) === 7;
  const missionRate = rate(week.missions_completed, week.missions_total);
  const habitRate = rate(week.habits_logged, week.habits_expected);

  return (
    <div className="stack" style={{ gap: 18 }}>
      <PageHeader
        eyebrow="Week"
        title={isSunday ? "Your week, reviewed" : "This week so far"}
        description={`${weekStart} to ${today}. Everything below comes from what you saved this week.${isSunday ? "" : " The full review is best on Sunday."}`}
      />

      <div className="grid">
        <Panel>
          <StatTile label="XP this week" value={<>{formatXp(week.xp_net)} <small>net</small></>} hint={`${formatXp(week.xp_awarded)} earned${week.xp_adjusted ? ` · ${formatXp(week.xp_adjusted)} corrected` : ""}`} />
        </Panel>
        <Panel>
          <StatTile label="Missions" value={<>{week.missions_completed}<small> / {week.missions_total} done</small></>} progress={missionRate ?? 0} hint={missionRate === null ? "Nothing was planned." : `${missionRate}% of planned work completed`} />
        </Panel>
        <Panel>
          <StatTile label="Habits" value={<>{week.habits_logged}<small> / {week.habits_expected} logged</small></>} progress={habitRate ?? 0} hint={habitRate === null ? "Nothing was scheduled." : `${habitRate}% of scheduled habit-days`} />
        </Panel>
        <Panel>
          <StatTile label="Focus" value={formatDuration(week.focus_seconds)} hint={`${week.focus_completed} of ${week.focus_sessions} sessions counted · ${week.achievements_unlocked} achievement${week.achievements_unlocked === 1 ? "" : "s"}`} />
        </Panel>
      </div>

      <div className="grid-wide">
        <Panel>
          <div className="stack-sm">
            <p className="eyebrow">Wins</p>
            <h2>{wins.length ? `${wins.length} mission${wins.length === 1 ? "" : "s"} finished` : "No missions finished yet"}</h2>
            {wins.length === 0 ? (
              <EmptyState title="Nothing completed this week" description="Finish one mission and it shows up here." />
            ) : (
              <div className="items">
                {wins.map((mission) => (
                  <article className="item" key={mission.id}>
                    <div className="row" style={{ gap: 8 }}>
                      <span className="item-title">{mission.title}</span>
                      <Badge tone="completed">{mission.mission_date}</Badge>
                    </div>
                    {mission.outcome ? <p className="faint">{mission.outcome}</p> : null}
                  </article>
                ))}
              </div>
            )}
          </div>
        </Panel>
        <Panel>
          <div className="stack-sm">
            <p className="eyebrow">Misses</p>
            <h2>{misses.length ? `${misses.length} to learn from` : "Nothing slipped"}</h2>
            {misses.length === 0 ? (
              <p className="muted">Every planned mission so far was completed or is still due today.</p>
            ) : (
              <div className="items">
                {misses.map((mission) => (
                  <article className="item" key={mission.id}>
                    <div className="row" style={{ gap: 8 }}>
                      <span className="item-title">{mission.title}</span>
                      <Badge tone={mission.status === "blocked" || mission.status === "skipped" ? mission.status : "blocked"}>
                        {mission.status === "planned" || mission.status === "active" ? "not done" : mission.status}
                      </Badge>
                    </div>
                    {mission.outcome ? <p className="faint">{mission.outcome}</p> : null}
                  </article>
                ))}
              </div>
            )}
          </div>
        </Panel>
      </div>

      <Panel>
        <div className="stack-sm">
          <p className="eyebrow">Next week</p>
          <h2>Three missions that matter most</h2>
          <p className="muted">They&apos;re added as high-priority missions for Monday {nextMonday}. Leave a line empty if you need fewer.</p>
          <ActionForm action={planNextWeek} submitLabel="Set next week's missions" hidden={{ missionDate: nextMonday }}>
            <div className="stack-sm">
              <Field label="First" htmlFor="week-first"><input id="week-first" name="first" maxLength={200} placeholder="The one that moves everything else" /></Field>
              <Field label="Second" htmlFor="week-second"><input id="week-second" name="second" maxLength={200} /></Field>
              <Field label="Third" htmlFor="week-third"><input id="week-third" name="third" maxLength={200} /></Field>
            </div>
          </ActionForm>
        </div>
      </Panel>
    </div>
  );
}
