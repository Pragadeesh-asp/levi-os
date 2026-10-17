import type { Metadata } from "next";
import Link from "next/link";
import { ActionButton, ActionForm } from "@/components/ActionForm";
import {
  Badge,
  ConfigurationNotice,
  EmptyState,
  Field,
  Notice,
  PageHeader,
  Panel,
  SignedOutState,
  StatTile,
} from "@/components/ui";
import { toLocalTime } from "@/lib/dates";
import { formatDuration, isStaleSession } from "@/lib/focus";
import {
  getFocusSessionsForDay,
  getFocusSummary,
  getMissionById,
  getMissionsForDate,
  getRecentFocusSessions,
  getRunningFocusSession,
  getSessionContext,
  isSupabaseConfigured,
  type FocusSessionLogRow,
} from "@/lib/queries";
import { endFocus, startFocus } from "./actions";

export const metadata: Metadata = { title: "Focus · LEVI OS" };

function SessionLine({
  session,
  timeZone,
  missionTitles,
}: {
  session: FocusSessionLogRow;
  timeZone: string;
  missionTitles: Map<string, string>;
}) {
  const running = session.ended_at === null;
  return (
    <article className="item">
      <div className="row-between" style={{ alignItems: "flex-start" }}>
        <div className="stack-sm" style={{ minWidth: 0 }}>
          <div className="row" style={{ gap: 8 }}>
            <span className="item-title">{session.intent}</span>
            {running ? <Badge tone="active">running</Badge> : null}
            {session.ended_reason === "completed" ? <Badge tone="completed">focused</Badge> : null}
            {session.ended_reason === "discarded" ? <Badge tone="skipped">discarded</Badge> : null}
          </div>
          <p className="faint">
            {[
              `${session.started_on} ${toLocalTime(session.started_at, timeZone)}`,
              session.ended_at ? `until ${toLocalTime(session.ended_at, timeZone)}` : null,
              session.mission_id
                ? `mission: ${missionTitles.get(session.mission_id) ?? "no longer in the plan"}`
                : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
        <span className="badge" title={running ? "Running so far" : "Recorded duration"}>
          {formatDuration(Number(session.elapsed_seconds))}
        </span>
      </div>
    </article>
  );
}

/**
 * Focus sessions: measured blocks of attention.
 *
 * The database starts the clock, ends the clock and computes the duration, so this
 * screen can never flatter the user with time that was not spent. Nothing is banked
 * until the session is ended, a session that was left running can be *discarded*
 * (kept as a record, counted as zero), and no XP is awarded — the ledger pays for
 * evidenced outcomes, not for minutes on a clock.
 */
export default async function FocusPage() {
  if (!isSupabaseConfigured()) return <ConfigurationNotice />;
  const session = await getSessionContext();
  if (!session) return <SignedOutState module="Focus" />;
  const { supabase, today, timeZone } = session;

  const running = await getRunningFocusSession(supabase);
  const [summary, missions, todays, recent, runningMission] = await Promise.all([
    getFocusSummary(supabase, today, timeZone),
    getMissionsForDate(supabase, today),
    getFocusSessionsForDay(supabase, today),
    getRecentFocusSessions(supabase, 15),
    running?.mission_id ? getMissionById(supabase, running.mission_id) : Promise.resolve(null),
  ]);

  const now = new Date();
  const missionTitles = new Map(missions.map((mission) => [mission.id, mission.title]));
  if (runningMission) missionTitles.set(runningMission.id, runningMission.title);
  const openMissions = missions.filter((mission) => mission.status === "planned" || mission.status === "active");
  const runningSeconds = running
    ? Math.max(0, Math.floor((now.getTime() - new Date(running.started_at).getTime()) / 1000))
    : 0;
  const stale = running ? isStaleSession(running.started_at, now) : false;
  const earlier = recent.filter((row) => row.ended_at !== null && row.started_on !== today);

  return (
    <div className="stack" style={{ gap: 18 }}>
      <PageHeader
        eyebrow="Focus"
        title="Measured attention, not claimed hours"
        description={`The database timestamps every session and computes the duration itself, in ${timeZone}. At most one session can run at a time, and none of it awards XP.`}
        actions={
          <Link className="button secondary" href="/review">
            Review today
          </Link>
        }
      />

      {running ? (
        <Panel>
          <div className="stack-sm">
            <p className="eyebrow">Running now</p>
            <h2>{running.intent}</h2>
            <p className="muted">
              Started at {toLocalTime(running.started_at, timeZone)} on {running.started_on}
              {running.mission_id
                ? ` · mission: ${missionTitles.get(running.mission_id) ?? "no longer in the plan"}`
                : ""}
              {" · "}
              <strong>{formatDuration(runningSeconds)}</strong> so far.
            </p>
            {stale ? (
              <Notice kind="info">
                This session has been running for {formatDuration(runningSeconds)} — far longer than a block of
                real work. It looks like it was left open. Discarding keeps the record without counting the
                time.
              </Notice>
            ) : null}
            <div className="row">
              <ActionForm action={endFocus} submitLabel="End session" hidden={{ sessionId: running.id, discard: "false" }} pendingLabel="Ending…">
                <span className="faint">
                  Ending records the time that has actually passed. The duration is the database&apos;s, not the
                  browser&apos;s.
                </span>
              </ActionForm>
              <ActionButton
                action={endFocus}
                label="Discard instead"
                fields={{ sessionId: running.id, discard: "true" }}
                variant="danger"
                confirm="yes"
                pendingLabel="Discarding…"
              />
            </div>
          </div>
        </Panel>
      ) : (
        <Panel>
          <div className="stack-sm">
            <p className="eyebrow">Start</p>
            <h2>Begin a block of focus</h2>
            <ActionForm action={startFocus} submitLabel="Start focusing" pendingLabel="Starting…">
              <Field
                label="What are you focusing on?"
                htmlFor="focus-intent"
                hint="The outcome of this block, not the activity: “Draft section 4 of the audit”, not “work”."
              >
                <input
                  id="focus-intent"
                  name="intent"
                  required
                  maxLength={200}
                  placeholder="e.g. Finish the Stage B migration"
                />
              </Field>
              {openMissions.length > 0 ? (
                <Field label="Link to an open mission" htmlFor="focus-mission" hint="Optional. The link is a pointer, never a claim that the mission is done.">
                  <select id="focus-mission" name="missionId" defaultValue="">
                    <option value="">Not linked to a mission</option>
                    {openMissions.map((mission) => (
                      <option key={mission.id} value={mission.id}>
                        {mission.priority === "urgent" ? "▲ " : ""}
                        {mission.title}
                      </option>
                    ))}
                  </select>
                </Field>
              ) : null}
            </ActionForm>
          </div>
        </Panel>
      )}

      <div className="grid">
        <Panel>
          <StatTile
            label="Focused today"
            value={
              <>
                {formatDuration(summary.focused_seconds)}
              </>
            }
            hint={
              summary.sessions_completed === 0
                ? "No finished session today yet — a running one does not count until it is ended."
                : `${summary.sessions_completed} finished ${summary.sessions_completed === 1 ? "session" : "sessions"} counted.`
            }
          />
        </Panel>
        <Panel>
          <StatTile
            label="Sessions today"
            value={
              <>
                {summary.sessions_total}
                <small> started</small>
              </>
            }
            hint={`${summary.sessions_discarded} discarded · a session belongs to the day it started on.`}
          />
        </Panel>
        <Panel>
          <StatTile
            label="Running"
            value={<>{running ? "Yes" : "No"}</>}
            hint={
              running
                ? `Since ${toLocalTime(running.started_at, timeZone)} — end or discard it to start another.`
                : "Nothing is running. One session at a time, enforced by the database."
            }
          />
        </Panel>
      </div>

      <Panel>
        <div className="stack-sm">
          <p className="eyebrow">Today</p>
          <h2>Sessions started on {today}</h2>
          {todays.length === 0 ? (
            <EmptyState
              title="No session today"
              description="Start one above when a block of real work begins. It is the only way this page ever shows time."
            />
          ) : (
            <div className="items">
              {todays.map((row) => (
                <SessionLine key={row.id} session={row} timeZone={timeZone} missionTitles={missionTitles} />
              ))}
            </div>
          )}
        </div>
      </Panel>

      {earlier.length > 0 ? (
        <Panel>
          <div className="stack-sm">
            <p className="eyebrow">History</p>
            <h2>Earlier sessions</h2>
            <div className="items">
              {earlier.slice(0, 10).map((row) => (
                <SessionLine key={row.id} session={row} timeZone={timeZone} missionTitles={missionTitles} />
              ))}
            </div>
          </div>
        </Panel>
      ) : null}

      <Panel>
        <p className="eyebrow">How focus time is counted</p>
        <p className="muted">
          The start and the end are the database&apos;s own timestamps; the duration is their difference, so a
          browser cannot claim time that did not pass. A session only counts once it has been ended — a running
          one shows what has elapsed so far and banks nothing. Discarding a session that was left open keeps the
          record but counts as zero, which is how an interrupted timer stays honest. No XP is awarded for any of
          it: the ledger pays for evidenced outcomes, and minutes on a clock are not one.
        </p>
      </Panel>
    </div>
  );
}
