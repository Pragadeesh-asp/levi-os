import type { Metadata } from "next";
import Link from "next/link";
import { Badge, ConfigurationNotice, EmptyState, PageHeader, Panel, ProgressBar, SignedOutState, StatTile } from "@/components/ui";
import { describeAction, rate, sumDays, trendBars, XP_SOURCE_LABELS } from "@/lib/analytics";
import { addDays, toCalendarDate, toLocalTime } from "@/lib/dates";
import { formatDuration } from "@/lib/focus";
import { isScheduledOn, scheduleFromWeekdays } from "@/lib/habits";
import {
  countByStatus,
  getAchievements,
  getAnalyticsRange,
  getHabitLogsBetween,
  getHabitSummaries,
  getLevelHistory,
  getMissionsForDate,
  getOverdueMissions,
  getPlayerStats,
  getQuestOverview,
  getRecentActions,
  getSessionContext,
  getXpBySource,
  isSupabaseConfigured,
  type PlayerStats,
} from "@/lib/queries";
import { formatXp } from "@/lib/utils";

export const metadata: Metadata = { title: "Today · LEVI OS" };

const EMPTY_STATS: PlayerStats = {
  user_id: "",
  total_xp: 0,
  level: 1,
  current_level_floor_xp: 0,
  xp_into_level: 0,
  xp_for_next_level: 250,
  xp_to_next_level: 250,
  quests_completed: 0,
  subquests_completed: 0,
  missions_completed: 0,
  missions_skipped: 0,
  missions_blocked: 0,
  habits_logged: 0,
  steps_completed: 0,
};

function percent(part: number, whole: number): number {
  return whole <= 0 ? 0 : Math.round((part / whole) * 100);
}

function signedXp(amount: number): string {
  return `${amount > 0 ? "+" : amount < 0 ? "−" : ""}${formatXp(Math.abs(amount))}`;
}

export default async function DashboardPage() {
  if (!isSupabaseConfigured()) return <ConfigurationNotice />;
  const session = await getSessionContext();
  if (!session) return <SignedOutState module="Today" />;
  const { supabase, today, timeZone, displayName } = session;

  const momentumFrom = addDays(today, -13);
  const [statsRow, missions, overdue, habits, todayLogs, quests, history, achievements, range, xpBySource, actions] =
    await Promise.all([
      getPlayerStats(supabase),
      getMissionsForDate(supabase, today),
      getOverdueMissions(supabase, today),
      getHabitSummaries(supabase, today),
      getHabitLogsBetween(supabase, today, today),
      getQuestOverview(supabase),
      getLevelHistory(supabase, 6),
      getAchievements(supabase),
      getAnalyticsRange(supabase, momentumFrom, today, timeZone),
      getXpBySource(supabase),
      getRecentActions(supabase, 8),
    ]);

  const stats = statsRow ?? EMPTY_STATS;
  const counts = countByStatus(missions);
  const resolvedToday = counts.completed + counts.skipped;
  // "Next up" is the top of the user's own saved order for today — the same order
  // the Missions screen shows — not a priority computed here.
  const openMissions = missions.filter((mission) => mission.status === "planned" || mission.status === "active");
  const primary = openMissions[0] ?? null;

  const doneToday = new Set(todayLogs.filter((log) => log.completed).map((log) => log.habit_id));
  const habitsDue = habits.filter((habit) => isScheduledOn(scheduleFromWeekdays(habit.schedule_weekdays), today));
  const habitsDone = habitsDue.filter((habit) => doneToday.has(habit.habit_id)).length;

  const activeQuests = quests.filter((quest) => quest.status !== "done");
  const unlocked = achievements.filter((achievement) => achievement.unlockedAt !== null);
  const levelProgressPercent = percent(stats.xp_into_level, stats.xp_for_next_level);

  const momentumBars = trendBars(range, (day) => day.xp_net);
  const week = sumDays(range.filter((day) => day.day >= addDays(today, -6)));
  const weekMissionRate = rate(week.missions_completed, week.missions_total);
  const weekHabitRate = rate(week.habits_logged, week.habits_expected);
  const weekFocusRate = rate(week.focus_completed, week.focus_sessions);
  const hasMomentum = range.some(
    (day) =>
      day.xp_net !== 0 ||
      day.missions_total > 0 ||
      day.focus_sessions > 0 ||
      day.habits_logged > 0 ||
      day.achievements_unlocked > 0,
  );

  return (
    <div className="stack" style={{ gap: 18 }}>
      <PageHeader
        eyebrow="Today"
        title={displayName ? `What matters right now, ${displayName}?` : "What matters right now?"}
        description={`Today is ${today} in ${timeZone}. Every number below is derived from records you saved — nothing is estimated.`}
        actions={
          <>
            <Link className="button secondary" href="/missions">
              Plan today
            </Link>
            <Link className="button secondary" href="/review">
              Review today
            </Link>
            <Link className="button" href="/quests">
              Quests
            </Link>
          </>
        }
      />

      <div className="grid">
        <Panel>
          <StatTile
            label={`Level ${stats.level}`}
            value={
              <>
                {formatXp(stats.total_xp)} <small>XP lifetime</small>
              </>
            }
            progress={levelProgressPercent}
            hint={
              stats.xp_to_next_level > 0
                ? `${formatXp(stats.xp_into_level)} of ${formatXp(stats.xp_for_next_level)} into this level · ${formatXp(
                    stats.xp_to_next_level,
                  )} XP to level ${stats.level + 1}`
                : "Maximum tracked level reached."
            }
          />
        </Panel>

        <Panel>
          <StatTile
            label="Missions today"
            value={
              <>
                {counts.completed}
                <small> / {missions.length} completed</small>
              </>
            }
            progress={percent(counts.completed, missions.length)}
            hint={
              missions.length === 0
                ? "Nothing planned for today yet."
                : `${counts.planned + counts.active} open · ${resolvedToday} resolved · ${counts.blocked} blocked`
            }
          />
        </Panel>

        <Panel>
          <StatTile
            label="Habits due today"
            value={
              <>
                {habitsDone}
                <small> / {habitsDue.length} logged</small>
              </>
            }
            progress={percent(habitsDone, habitsDue.length)}
            hint={
              habits.length === 0
                ? "No habits tracked yet."
                : `${stats.habits_logged} completions all time across ${habits.length} habit(s).`
            }
          />
        </Panel>

        <Panel>
          <StatTile
            label="Quests"
            value={
              <>
                {stats.quests_completed}
                <small> main completed</small>
              </>
            }
            progress={percent(stats.quests_completed, stats.quests_completed + activeQuests.filter((q) => q.kind === "main").length)}
            hint={`${activeQuests.length} active · ${stats.subquests_completed} subquests closed · ${stats.steps_completed} steps with evidence`}
          />
        </Panel>
      </div>

      <div className="grid-wide">
        <Panel>
          <div className="row-between" style={{ marginBottom: 12 }}>
            <div>
              <p className="eyebrow">Momentum</p>
              <h2 style={{ marginTop: 4 }}>The last 14 days</h2>
            </div>
            <span className="faint">local days in {timeZone}</span>
          </div>

          {!hasMomentum ? (
            <EmptyState
              title="Nothing recorded in the last 14 days"
              description="Complete a mission, log a habit or close a quest and the trend starts here. A day with no records is shown as zero — never estimated."
            />
          ) : (
            <div className="stack">
              <ol className="trend" aria-label={`Daily XP net for the 14 days ending ${today}`}>
                {momentumBars.map((bar) => (
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
              <div className="row-between">
                <span className="faint">
                  {range[0]?.day} → {range[range.length - 1]?.day}
                </span>
                <span className="faint">red = corrections outweighed awards</span>
              </div>

              <div className="grid">
                <div className="stack-sm">
                  <span className="stat-label">XP net · last 7 days</span>
                  <span className="stat-value">
                    {signedXp(week.xp_net)} <small>XP</small>
                  </span>
                  <span className="faint">
                    {formatXp(week.xp_awarded)} awarded · {signedXp(week.xp_adjusted)} adjusted
                  </span>
                </div>
                <div className="stack-sm">
                  <span className="stat-label">Missions · last 7 days</span>
                  <span className="stat-value">
                    {week.missions_completed} <small>/ {week.missions_total} completed</small>
                  </span>
                  <span className="faint">
                    {weekMissionRate === null
                      ? "Nothing was planned."
                      : `${weekMissionRate}% of planned work completed`}
                  </span>
                </div>
                <div className="stack-sm">
                  <span className="stat-label">Focus · last 7 days</span>
                  <span className="stat-value">{formatDuration(week.focus_seconds)}</span>
                  <span className="faint">
                    {weekFocusRate === null
                      ? "No session was started."
                      : `${week.focus_completed} of ${week.focus_sessions} sessions counted · ${weekFocusRate}%`}
                  </span>
                </div>
                <div className="stack-sm">
                  <span className="stat-label">Habits · last 7 days</span>
                  <span className="stat-value">
                    {week.habits_logged} <small>/ {week.habits_expected} logged</small>
                  </span>
                  <span className="faint">
                    {weekHabitRate === null
                      ? "Nothing was scheduled."
                      : `${weekHabitRate}% of scheduled habit-days`}
                  </span>
                </div>
                <div className="stack-sm">
                  <span className="stat-label">Achievements · last 7 days</span>
                  <span className="stat-value">{week.achievements_unlocked}</span>
                  <span className="faint">
                    {week.achievements_unlocked === 0 ? "None unlocked." : "Unlocked by this week's work."}
                  </span>
                </div>
              </div>

              <p className="faint">
                Net XP means awards plus corrections. Reopened missions are not counted as completed, and discarded
                focus sessions contribute no time.
              </p>
            </div>
          )}
        </Panel>

        <Panel>
          <div className="stack-sm">
            <p className="eyebrow">Sources</p>
            <h2>Where XP comes from</h2>
            {xpBySource.length === 0 ? (
              <p className="muted">
                No XP has been written to the ledger yet. Missions, habits and quest steps each report under their
                own source.
              </p>
            ) : (
              <>
                <p className="muted">
                  Lifetime net by source. An adjustment stays under the source of the award it corrected, so a
                  reopened mission cannot invent a new category.
                </p>
                <div className="items">
                  {xpBySource.map((row) => (
                    <article className="item" key={row.source}>
                      <div className="row-between">
                        <div className="stack-sm">
                          <span className="item-title">{XP_SOURCE_LABELS[row.source]}</span>
                          <span className="faint">
                            {formatXp(row.awarded)} awarded
                            {row.adjusted !== 0 ? ` · ${signedXp(row.adjusted)} corrected` : ""}
                          </span>
                        </div>
                        <span className="badge" title={`${row.entries} ledger entries`}>
                          {signedXp(row.net)} XP
                        </span>
                      </div>
                    </article>
                  ))}
                </div>
              </>
            )}
          </div>
        </Panel>
      </div>

      <div className="grid-wide">
        <div className="stack" style={{ gap: 18 }}>
          <Panel>
            <div className="row-between" style={{ marginBottom: 12 }}>
              <div>
                <p className="eyebrow">Today</p>
                <h2 style={{ marginTop: 4 }}>Today&apos;s missions</h2>
              </div>
              <Link className="button secondary tiny" href="/missions">
                Open missions
              </Link>
            </div>

            {missions.length === 0 ? (
              <EmptyState
                title="Nothing planned for today"
                description="A mission is one concrete outcome. Add it in Missions and it lands on today's list."
                action={
                  <Link className="button tiny" href="/missions">
                    Plan a mission
                  </Link>
                }
              />
            ) : (
              <div className="items">
                {missions.map((mission) => (
                  <article className="item" key={mission.id}>
                    <div className="row-between" style={{ alignItems: "flex-start" }}>
                      <div className="stack-sm" style={{ minWidth: 0 }}>
                        <div className="row" style={{ gap: 8 }}>
                          <span className="item-title">{mission.title}</span>
                          <Badge tone={mission.status}>{mission.status}</Badge>
                          <Badge tone={mission.priority}>{mission.priority}</Badge>
                          {mission.id === primary?.id ? <Badge tone="active">next up</Badge> : null}
                        </div>
                        {mission.success_criteria ? (
                          <p className="faint">done when: {mission.success_criteria}</p>
                        ) : null}
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </Panel>

          {overdue.length > 0 ? (
            <Panel>
              <div className="stack-sm">
                <p className="eyebrow">Carried over</p>
                <h2>
                  {overdue.length} unresolved mission{overdue.length === 1 ? "" : "s"} from earlier days
                </h2>
                <p className="muted">
                  These were planned for a previous day and never completed, skipped or blocked. Resolve them
                  honestly — carried work is the fastest way to lose trust in the plan.
                </p>
                <div className="items">
                  {overdue.slice(0, 5).map((mission) => (
                    <article className="item" key={mission.id}>
                      <div className="row" style={{ gap: 8 }}>
                        <span className="item-title">{mission.title}</span>
                        <Badge tone="blocked">{mission.mission_date}</Badge>
                        <Badge tone={mission.priority}>{mission.priority}</Badge>
                      </div>
                    </article>
                  ))}
                </div>
                <div className="row">
                  <Link className="button secondary tiny" href="/missions">
                    Resolve in missions
                  </Link>
                </div>
              </div>
            </Panel>
          ) : null}

          <Panel>
            <div className="row-between" style={{ marginBottom: 12 }}>
              <div>
                <p className="eyebrow">Trajectory</p>
                <h2 style={{ marginTop: 4 }}>Active quests</h2>
              </div>
              <Link className="button secondary tiny" href="/quests">
                Open quests
              </Link>
            </div>
            {activeQuests.length === 0 ? (
              <EmptyState
                title="No quests in play"
                description="Quests are the outcomes worth months of work. Create one, then break it into subquests and evidenced steps."
                action={
                  <Link className="button tiny" href="/quests">
                    Create a quest
                  </Link>
                }
              />
            ) : (
              <div className="stack">
                {activeQuests.map((quest) => (
                  <div className="stack-sm" key={quest.id}>
                    <div className="row-between">
                      <span className="row" style={{ gap: 8 }}>
                        <span className="item-title">{quest.title}</span>
                        <Badge>{quest.kind}</Badge>
                        {quest.due_date ? <Badge>due {quest.due_date}</Badge> : null}
                      </span>
                      <span className="faint numeric">{quest.progress_percent}%</span>
                    </div>
                    <ProgressBar
                      value={quest.progress_percent}
                      label={`${quest.title} progress`}
                      tone={quest.progress_percent >= 100 ? "success" : undefined}
                    />
                  </div>
                ))}
              </div>
            )}
          </Panel>
        </div>

        <div className="stack" style={{ gap: 18 }}>
          <Panel>
            <div className="stack-sm">
              <p className="eyebrow">Ledger</p>
              <h2>Recent XP</h2>
              {history.length === 0 ? (
                <p className="muted">
                  No XP recorded yet. Completing a mission, logging a habit or closing a quest writes an
                  append-only entry here.
                </p>
              ) : (
                <div className="items">
                  {history.map((event) => (
                    <article className="item" key={event.event_id}>
                      <div className="row-between">
                        <div className="stack-sm">
                          <span className="item-title">
                            {XP_SOURCE_LABELS[event.source] ?? event.source}
                          </span>
                          <span className="faint">
                            {toCalendarDate(event.awarded_at, timeZone)} · level {event.level_after}
                          </span>
                        </div>
                        <span className="badge" title="XP change">
                          {signedXp(event.amount)} XP
                        </span>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </div>
          </Panel>

          <Panel>
            <div className="stack-sm">
              <p className="eyebrow">History</p>
              <h2>Recent activity</h2>
              {actions.length === 0 ? (
                <p className="muted">
                  Nothing recorded yet. The action history starts with this release — earlier changes were never
                  stored, and this page does not reconstruct them.
                </p>
              ) : (
                <div className="items">
                  {actions.map((action) => (
                    <article className="item" key={action.id}>
                      <div className="stack-sm">
                        <span className="item-title">
                          {describeAction(action.kind, action.detail, action.subject_label)}
                        </span>
                        <span className="faint numeric">
                          {action.occurred_on} · {toLocalTime(action.occurred_at, timeZone)}
                        </span>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </div>
          </Panel>

          <Panel>
            <div className="stack-sm">
              <p className="eyebrow">Achievements</p>
              <h2>
                {unlocked.length} of {achievements.length} unlocked
              </h2>
              <ProgressBar
                value={percent(unlocked.length, achievements.length)}
                label="Achievements unlocked"
                tone={unlocked.length === achievements.length ? "success" : undefined}
              />
              <div className="items">
                {achievements.map((achievement) => {
                  const isUnlocked = achievement.unlockedAt !== null;
                  return (
                    <article className="item" key={achievement.id}>
                      <div className="row-between">
                        <div className="stack-sm">
                          <span className="item-title">{achievement.title}</span>
                          <span className="faint">{achievement.description}</span>
                        </div>
                        <Badge tone={isUnlocked ? "completed" : undefined}>
                          {isUnlocked ? "unlocked" : `+${achievement.xp} XP`}
                        </Badge>
                      </div>
                    </article>
                  );
                })}
              </div>
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}
