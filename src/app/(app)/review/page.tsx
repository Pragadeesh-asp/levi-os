import type { Metadata } from "next";
import Link from "next/link";
import { Badge, ConfigurationNotice, EmptyState, PageHeader, Panel, SignedOutState, StatTile } from "@/components/ui";
import { describeAction, rate, sumDays, trendBars } from "@/lib/analytics";
import { addDays, toLocalTime } from "@/lib/dates";
import { formatDuration } from "@/lib/focus";
import {
  getAllHabits,
  getActionsForDay,
  getAnalyticsRange,
  getDaySummary,
  getFocusSessionsForDay,
  getFocusSummary,
  getHabitLogsBetween,
  getMissionsForDate,
  getSessionContext,
  isSupabaseConfigured,
} from "@/lib/queries";
import { relativeDayLabel, resolveReviewDate } from "@/lib/review";
import { formatXp } from "@/lib/utils";

export const metadata: Metadata = { title: "Day review · LEVI OS" };

function signedXp(amount: number): string {
  return `${amount > 0 ? "+" : amount < 0 ? "−" : ""}${formatXp(Math.abs(amount))}`;
}

/**
 * A read-only record of one finished day.
 *
 * Every figure comes from `day_summary(date, time_zone)`, which the database computes
 * from the stored rows — no estimate, no mock, and no figure is recomputed in the UI.
 * Resolving work still happens on the missions and habits screens, which is why this
 * page links there instead of duplicating their actions.
 */
export default async function ReviewPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string | string[] }>;
}) {
  if (!isSupabaseConfigured()) return <ConfigurationNotice />;
  const session = await getSessionContext();
  if (!session) return <SignedOutState module="Day review" />;
  const { supabase, today, timeZone } = session;

  const params = await searchParams;
  const date = resolveReviewDate(params.date, today);
  const isToday = date === today;

  const [summary, missions, logs, habits, focus, focusSessions, range, actions] = await Promise.all([
    getDaySummary(supabase, date, timeZone),
    getMissionsForDate(supabase, date),
    getHabitLogsBetween(supabase, date, date),
    getAllHabits(supabase),
    getFocusSummary(supabase, date, timeZone),
    getFocusSessionsForDay(supabase, date),
    getAnalyticsRange(supabase, addDays(date, -13), date, timeZone),
    getActionsForDay(supabase, date),
  ]);

  const habitNames = new Map(habits.map((habit) => [habit.id, habit.name]));
  const loggedHabits = logs.filter((log) => log.completed);
  const missedHabits = logs.filter((log) => !log.completed);
  const doneMissions = missions.filter((mission) => mission.status === "completed");
  const resolvedMissions = missions.filter(
    (mission) => mission.status === "skipped" || mission.status === "blocked",
  );
  const openMissions = missions.filter(
    (mission) => mission.status === "planned" || mission.status === "active",
  );
  const habitRate =
    summary.habits_expected > 0 ? Math.round((summary.habits_logged / summary.habits_expected) * 100) : 0;

  const weekDays = range.filter((row) => row.day >= addDays(date, -6));
  const week = sumDays(weekDays);
  const previous = sumDays(range.filter((row) => row.day < addDays(date, -6)));
  const weekMissionRate = rate(week.missions_completed, week.missions_total);
  const weekHabitRate = rate(week.habits_logged, week.habits_expected);
  const weekBars = trendBars(weekDays, (row) => row.xp_net);

  return (
    <div className="stack" style={{ gap: 18 }}>
      <PageHeader
        eyebrow="Day review"
        title={`${relativeDayLabel(date, today)} · ${date}`}
        description={`A read-only record of this day in ${timeZone}. Every number below is computed by the database from the rows that were actually saved.`}
        actions={
          <>
            <Link className="button secondary" href={{ pathname: "/review", query: { date: addDays(date, -1) } }}>
              ← Previous day
            </Link>
            {!isToday ? (
              <Link className="button secondary" href="/review">
                Today
              </Link>
            ) : null}
            {!isToday ? (
              <Link className="button secondary" href={{ pathname: "/review", query: { date: addDays(date, 1) } }}>
                Next day →
              </Link>
            ) : null}
          </>
        }
      />

      <Panel>
        <form method="get" className="row" style={{ alignItems: "flex-end" }}>
          <div className="field">
            <label htmlFor="review-date">Review a different day</label>
            <input id="review-date" type="date" name="date" defaultValue={date} max={today} required />
          </div>
          <button className="button secondary" type="submit">
            View day
          </button>
        </form>
      </Panel>

      <div className="grid">
        <Panel>
          <StatTile
            label="XP recorded"
            value={
              <>
                {signedXp(summary.xp_net)} <small>XP</small>
              </>
            }
            hint={
              summary.xp_adjusted === 0
                ? `${formatXp(summary.xp_awarded)} XP awarded, no corrections.`
                : `${formatXp(summary.xp_awarded)} XP awarded · ${signedXp(summary.xp_adjusted)} adjusted.`
            }
          />
        </Panel>
        <Panel>
          <StatTile
            label="Missions"
            value={
              <>
                {doneMissions.length} <small>/ {missions.length} completed</small>
              </>
            }
            progress={missions.length > 0 ? Math.round((doneMissions.length / missions.length) * 100) : 0}
            tone={doneMissions.length === missions.length && missions.length > 0 ? "success" : "default"}
            hint={
              missions.length === 0
                ? "No mission was planned for this day."
                : `${openMissions.length} left open · ${resolvedMissions.length} resolved with a reason.`
            }
          />
        </Panel>
        <Panel>
          <StatTile
            label="Habits"
            value={
              <>
                {summary.habits_logged} <small>/ {summary.habits_expected} expected</small>
              </>
            }
            progress={habitRate}
            tone={habitRate >= 100 && summary.habits_expected > 0 ? "success" : "default"}
            hint={
              summary.habits_expected === 0
                ? "No habit was scheduled for this day."
                : `${habitRate}% of the habits scheduled for this day were logged.`
            }
          />
        </Panel>
        <Panel>
          <StatTile
            label="Focus"
            value={
              <>
                {formatDuration(focus.focused_seconds)}
              </>
            }
            hint={
              focus.sessions_total === 0
                ? "No focus session was started on this day."
                : `${focus.sessions_completed} counted · ${focus.sessions_discarded} discarded${
                    focus.sessions_open > 0 ? " · one left running" : ""
                  }.`
            }
          />
        </Panel>
        <Panel>
          <StatTile
            label="Achievements"
            value={
              <>
                {summary.achievements_unlocked} <small>unlocked</small>
              </>
            }
            hint={
              summary.achievements_unlocked === 0
                ? "Nothing new was unlocked on this day."
                : "Unlocked by work recorded on this day."
            }
          />
        </Panel>
      </div>

      <div className="grid-wide">
        <Panel>
          <div className="row-between" style={{ marginBottom: 12 }}>
            <div>
              <p className="eyebrow">Trend</p>
              <h2 style={{ marginTop: 4 }}>Seven days ending {date}</h2>
            </div>
            <span className="faint">local days in {timeZone}</span>
          </div>
          {range.length === 0 ? (
            <EmptyState
              title="No trend available"
              description="The database returned no days for this window, so no chart is drawn."
            />
          ) : (
            <div className="stack">
              <ol className="trend" aria-label={`Daily XP net for the seven days ending ${date}`}>
                {weekBars.map((bar) => (
                  <li
                    key={bar.day}
                    className={bar.negative ? "negative" : bar.value > 0 ? "positive" : "zero"}
                    style={{ height: `${bar.percent}%` }}
                    title={`${bar.day}: ${signedXp(bar.value)} XP net`}
                  >
                    <span className="sr-only">
                      {bar.day}: {signedXp(bar.value)} XP net
                    </span>
                  </li>
                ))}
              </ol>
              <div className="stack-sm">
                <div className="row-between">
                  <span className="muted">XP net</span>
                  <span className="numeric">{signedXp(week.xp_net)}</span>
                </div>
                <div className="row-between">
                  <span className="muted">Missions completed</span>
                  <span className="numeric">
                    {week.missions_completed} / {week.missions_total}
                    {weekMissionRate === null ? "" : ` · ${weekMissionRate}%`}
                  </span>
                </div>
                <div className="row-between">
                  <span className="muted">Habit-days logged</span>
                  <span className="numeric">
                    {week.habits_logged} / {week.habits_expected}
                    {weekHabitRate === null ? "" : ` · ${weekHabitRate}%`}
                  </span>
                </div>
                <div className="row-between">
                  <span className="muted">Focus time</span>
                  <span className="numeric">{formatDuration(week.focus_seconds)}</span>
                </div>
                <div className="row-between">
                  <span className="muted">Achievements unlocked</span>
                  <span className="numeric">{week.achievements_unlocked}</span>
                </div>
              </div>
              <p className="faint">
                Previous seven days: {signedXp(previous.xp_net)} XP net · {previous.missions_completed} missions
                completed · {formatDuration(previous.focus_seconds)} focused. Bars show net XP; a red mark is a day
                whose corrections outweighed its awards.
              </p>
            </div>
          )}
        </Panel>

        <Panel>
          <div className="row-between" style={{ marginBottom: 12 }}>
            <div>
              <p className="eyebrow">History</p>
              <h2 style={{ marginTop: 4 }}>Recorded on this day</h2>
            </div>
            <span className="faint">
              {actions.length} event{actions.length === 1 ? "" : "s"}
            </span>
          </div>
          {actions.length === 0 ? (
            <EmptyState
              title="Nothing recorded in the action history"
              description="The history starts with the release that introduced it. Days before that were never stored, and this page does not claim to reconstruct them."
            />
          ) : (
            <div className="items">
              {actions.map((action) => (
                <article className="item" key={action.id}>
                  <div className="row-between">
                    <span>{describeAction(action.kind, action.detail, action.subject_label)}</span>
                    <span className="faint numeric">{toLocalTime(action.occurred_at, timeZone)}</span>
                  </div>
                </article>
              ))}
            </div>
          )}
        </Panel>
      </div>

      <Panel>
        <div className="row-between">
          <h2>Missions planned for this day</h2>
          <Link className="button secondary tiny" href={{ pathname: "/missions", query: { date } }}>
            Open this day in Missions
          </Link>
        </div>
        {missions.length === 0 ? (
          <EmptyState
            title="Nothing was planned"
            description="No mission was created for this date. That is a real answer — this page never invents work that was not saved."
          />
        ) : (
          <div className="stack" style={{ marginTop: 12 }}>
            {[...doneMissions, ...resolvedMissions, ...openMissions].map((mission) => (
              <article className="item" key={mission.id}>
                <div className="stack-sm" style={{ minWidth: 0 }}>
                  <div className="row" style={{ gap: 8 }}>
                    <span className="item-title">{mission.title}</span>
                    <Badge tone={mission.status}>{mission.status}</Badge>
                    <Badge tone={mission.priority}>{mission.priority}</Badge>
                    {mission.position !== null ? <Badge>position {mission.position + 1}</Badge> : null}
                  </div>
                  {mission.success_criteria ? (
                    <p className="faint">done when: {mission.success_criteria}</p>
                  ) : null}
                  {mission.outcome ? <p className="muted">Outcome: {mission.outcome}</p> : null}
                  {!mission.outcome && (mission.status === "planned" || mission.status === "active") ? (
                    <p className="faint">Still open — this day ended without a recorded outcome.</p>
                  ) : null}
                </div>
              </article>
            ))}
          </div>
        )}
      </Panel>

      <Panel>
        <h2>Habits and their real state</h2>
        {logs.length === 0 ? (
          <EmptyState
            title="No habit was logged"
            description="No habit log was saved for this date — neither a completion nor an explicit miss. Unlogged days never break a streak."
          />
        ) : (
          <div className="stack" style={{ marginTop: 12 }}>
            {loggedHabits.map((log) => (
              <div className="row" style={{ gap: 8 }} key={log.id}>
                <Badge tone="active">done</Badge>
                <span>{habitNames.get(log.habit_id) ?? "Archived habit"}</span>
                {log.note ? <span className="faint">— {log.note}</span> : null}
              </div>
            ))}
            {missedHabits.map((log) => (
              <div className="row" style={{ gap: 8 }} key={log.id}>
                <Badge tone="skipped">missed</Badge>
                <span>{habitNames.get(log.habit_id) ?? "Archived habit"}</span>
                <span className="faint">— recorded as not done, which is why it breaks the streak</span>
              </div>
            ))}
          </div>
        )}
      </Panel>

      <Panel>
        <div className="row-between">
          <h2>Focus sessions started on this day</h2>
          <Link className="button secondary tiny" href="/focus">
            Open Focus
          </Link>
        </div>
        {focusSessions.length === 0 ? (
          <EmptyState
            title="No focus session"
            description="Nothing was timed on this date. A session belongs to the local day it started on, even when it ran past midnight."
          />
        ) : (
          <div className="stack" style={{ marginTop: 12 }}>
            {focusSessions.map((row) => (
              <article className="item" key={row.id}>
                <div className="row-between" style={{ alignItems: "flex-start" }}>
                  <div className="stack-sm" style={{ minWidth: 0 }}>
                    <div className="row" style={{ gap: 8 }}>
                      <span className="item-title">{row.intent}</span>
                      {row.ended_at === null ? <Badge tone="active">running</Badge> : null}
                      {row.ended_reason === "completed" ? <Badge tone="completed">counted</Badge> : null}
                      {row.ended_reason === "discarded" ? <Badge tone="skipped">discarded</Badge> : null}
                    </div>
                    <p className="faint">
                      {[
                        `${toLocalTime(row.started_at, timeZone)}`,
                        row.ended_at ? `until ${toLocalTime(row.ended_at, timeZone)}` : "still running",
                        row.mission_id ? "linked to a mission" : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                  </div>
                  <span className="badge" title="Recorded duration">
                    {formatDuration(Number(row.elapsed_seconds))}
                  </span>
                </div>
              </article>
            ))}
          </div>
        )}
      </Panel>

      <Panel>
        <p className="eyebrow">How this day is counted</p>
        <p className="muted">
          XP belongs to the local day it was <em>recorded</em> in {timeZone}. Backfilling an old habit today adds
          the log to that earlier day but never rewrites the XP of a finished review — the ledger stays
          append-only. Missions, habits and achievements are counted from the rows themselves, so this page can
          only ever show what was actually saved. Focus time is measured between two database timestamps and
          contributes no XP at all: only sessions that were ended normally are counted, and a discarded one keeps
          its record without banking its time.
        </p>
      </Panel>
    </div>
  );
}
