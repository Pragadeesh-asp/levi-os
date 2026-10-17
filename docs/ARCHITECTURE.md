# LEVI OS — Architecture

This document explains **why** the system is shaped the way it is. The invariant behind
every rule is the same:

> state is derived from records, and records are append-only where money or XP is
> involved. Anything a user can see must be traceable to something they saved.

## 1. Layering

```
┌─────────────────────────────────────────────────────────────────┐
│ Server Components (src/app/(app)/**)                            │
│   read-only: call queries.ts, render UI, never mutate           │
├─────────────────────────────────────────────────────────────────┤
│ Server Actions ("use server")                                   │
│   validate input → call an RPC or a scoped insert/update        │
│   → revalidate → return an ActionResult for the form to show    │
├─────────────────────────────────────────────────────────────────┤
│ Data access (src/lib/queries.ts, src/lib/auth.ts)               │
│   the only place that talks to Supabase                         │
├─────────────────────────────────────────────────────────────────┤
│ Domain engines (pure, tested)                                   │
│   progression.ts · habits.ts · finance.ts · dates.ts · review.ts│
│   focus.ts · ordering.ts · analytics.ts · input-validation.ts   │
│   quest-validation.ts                                           │
├─────────────────────────────────────────────────────────────────┤
│ PostgreSQL (supabase/migrations/**)                             │
│   constraints + RLS + security-definer RPCs are the last word   │
└─────────────────────────────────────────────────────────────────┘
```

Rules that keep the layering honest:

- **Clients never compute authoritative values.** The UI may format, but XP, levels,
  progress and streaks come from records (and, for streaks, from SQL).
- **The browser is never trusted.** Every server action re-validates its input with the
  shared cleaners in `src/lib/input-validation.ts`, and Postgres validates again with
  real constraints.
- **The database is the final authority.** A rule that matters (XP cannot be
  double-awarded, a habit log cannot be forged, a mission cannot be completed without an
  XP event) is enforced by a constraint, a trigger or an RPC — not only by the UI.

## 2. The XP ledger

`public.xp_ledger` is append-only. Every row has `(user_id, source, source_id, amount)`,
and `unique (user_id, source, source_id)` makes every award **idempotent**: the same
event can be retried any number of times and still awards once.

### Corrections without mutation

Un-checking a habit or reopening a mission must remove XP, but nothing may be deleted or
rewritten. Corrections are therefore **adjustment rows**:

- an adjustment has `reversal_of = <award id>`, `source` inherited from the award, a
  fresh `source_id` (so the award's unique key is untouched) and a negative or positive
  `amount`;
- a trigger (`validate_xp_adjustment`) keeps the balance
  `award.amount + Σ(adjustments) ∈ {0, award.amount}`. XP can be removed and restored,
  but it can never be counted twice or drift to a third value;
- an adjustment can never point at another adjustment.

This is why "log the same habit day twice" is safe, and why "reopen then re-complete"
restores exactly the original award.

### Award amounts (single source of truth)

Defined in `src/lib/progression.ts` (mirrored by the SQL callers):

| Event | XP |
| --- | --- |
| Daily mission completed | 50 |
| Habit day logged | 20 |
| Subquest completed (all steps evidenced) | 250 |
| Main quest completed (all subquests complete) | 1000 |
| Achievement | per definition (25–500) |

Mission _skipped_ and _blocked_ award 0 XP; they are recorded honestly with a required
reason.

## 3. Levels

One formula, implemented identically in TypeScript and SQL:

```
xp_for_level(L) = 250 * (L - 1) * L / 2      -- cumulative XP to *reach* level L
```

| Level | 1 | 2 | 3 | 4 | 5 | 6 |
| --- | --- | --- | --- | --- | --- | --- |
| XP to reach | 0 | 250 | 750 | 1500 | 2500 | 3750 |

Progress inside a level is always derived from the ledger total — never stored — so it
cannot drift from the events that produced it. The SQL view `player_stats` exposes
`total_xp`, `level`, `xp_into_level`, `xp_for_next_level` and `xp_to_next_level`; the TS
`levelProgress()` returns the same numbers. Both are covered by tests
(`src/lib/progression.test.ts`, `10_engine_assertions.sql`).

## 4. The daily loop

### Missions (`daily_missions`)

- **Create:** `create_mission(...)` RPC, or a direct insert that RLS restricts to
  `status in ('planned','active')` with no `completed_at` and no `outcome`.
- **Change state:** only `set_mission_status(...)` / `reopen_mission(...)`. There is no
  table-wide `update` grant on `daily_missions`; the client holds a **column-level** grant
  on the plan columns only (`title`, `priority`, `estimate_minutes`, `success_criteria`,
  `notes`, `mission_date`). A direct `status = 'completed'` write is rejected by Postgres
  itself, so a mission cannot be marked complete without the matching XP event.
- **Order:** `position` is deliberately **not** one of the client-editable plan columns.
  `reorder_missions(p_mission_date, p_ids uuid[])` takes *every* mission of one local day,
  exactly once, all owned by the caller, and rewrites their positions to `0..n-1` in that
  order. A partial list, a duplicate, a null entry or another user's mission is rejected —
  so a day can never end up with two missions sharing a position. The UI sends only
  "which mission moved which way"; the server rebuilds the full list from the stored rows,
  which makes a stale form a no-op instead of a corruption.
- **Delete:** allowed only while the mission has never awarded XP (enforced by trigger);
  otherwise reopen or skip it.
- **Invariant:** `daily_missions_state_check` requires a `completed_at` for completed
  missions and a non-empty `outcome` for skipped/blocked ones.

### Habits (`habits`, `habit_logs`)

- A habit day is one row per habit per **local calendar date** (`unique (habit_id, log_date)`).
- `habit_logs` is **SELECT-only** for clients; writes go through `log_habit(...)`, which is
  idempotent and moves the XP to match the row's state.
- Archiving (`archived_at`) hides a habit without deleting its history or its XP.

### Focus sessions (`focus_sessions`)

A focus session is one measured block of attention, and deliberately the *least* rewarding
feature in the system:

- **Measured, never typed.** `start_focus_session(intent, mission_id?)` and
  `end_focus_session(session_id, discard?)` are the only write paths. Both timestamps come
  from `now()`; the duration is `ended_at - started_at`, clamped at zero. No client-supplied
  number participates.
- **One running session per user**, enforced by a partial unique index
  (`unique (user_id) where ended_at is null`). Starting a second session fails with a clear
  message instead of silently closing the first — the first session's record must stay
  honest, even across two tabs or two devices.
- **Interrupted sessions are recorded, not fabricated.** Ending is idempotent: a double
  submit reports the stored truth and changes nothing. A session that was left running
  (closed tab, dead battery) can be **discarded**: `ended_reason = 'discarded'`, the row is
  kept, and its time is never counted. The UI suggests discarding after
  `STALE_SESSION_HOURS` (12 h), but never decides it for the user.
- **No XP — on purpose.** Time on a clock is not evidence of an outcome, and a per-minute
  reward would be the easiest thing in the system to farm. The test suite asserts that the
  focus RPCs write nothing to `xp_ledger`. A future reward rule would need its own migration
  and its own assertions.
- **A session belongs to the local day it started on**, even when it ran past midnight.
  `focus_summary(date, time_zone)` returns sessions started / completed / discarded / open
  and `focused_seconds`, which counts **completed** sessions only. `focus_session_log`
  (a `security_invoker` view) dates every session in the caller's zone, so no screen does
  time-zone arithmetic.
- **Read-only for clients.** There is no insert/update/delete grant or policy on
  `focus_sessions`; a session can only be started or ended through the RPCs above.

Linking a session to a mission is optional and checked twice: the RPC verifies ownership,
and a trigger repeats the check so no future write path can forget it. A link is a pointer,
never a claim that the mission is done.

## 5. The one streak rule

Implemented twice on purpose — once for display (`src/lib/habits.ts`) and once as the
authority (`habit_summary` in SQL) — with the same documented rule:

1. If today was explicitly logged as **not** completed → streak is **0** (the scheduled
   day was failed, not merely pending).
2. If today **is** completed → the streak ends today.
3. Otherwise today is still open → the streak is measured up to the most recent
   **scheduled** occurrence before today.

A day the habit was not scheduled for never breaks a streak. `habit_summary` uses
gaps-and-islands over *scheduled occurrences* (via `row_number()`), so a Mon/Wed/Fri habit
keeps its streak across unscheduled days instead of being reset every Tuesday.

## 6. Calendar dates and time zones

`profiles.time_zone` holds an IANA zone, validated server-side against
`pg_timezone_names` by the `set_time_zone(...)` RPC — a typo is rejected rather than
silently shifting every day.

Everything the user experiences is a **local calendar date** (`YYYY-MM-DD`):
`src/lib/dates.ts` converts an instant with `Intl` (`toCalendarDate`) and all date
arithmetic is done on date strings (`addDays`, `daysBetween`, `eachDate`, `isoWeekday`).
The client supplies `mission_date` / `log_date`, so work never lands on the wrong day
because the server runs in UTC. Pages resolve "today" once, in
`getSessionContext()`.

### 6.1 Backfill, and why the future is refused

A date the user supplies is data, so the database validates it:

- `log_habit` accepts any date **up to the caller's local today**. A past day may be
  backfilled — real life is recorded late — and a backfilled day keeps its own single row
  and its own single XP award.
- A **future** date is rejected (`A habit cannot be logged for a future calendar date`),
  computed from the zone stored in `profiles.time_zone`. A future day is not evidence of
  work that happened. The reference is never the server's UTC date: a user twelve hours
  behind UTC would otherwise be allowed to log the server's tomorrow.
- A missing date is rejected as well, so a malformed form cannot write an empty day.

## 7. Historical day review

`day_summary(p_date date, p_time_zone text)` returns exactly one row describing one *local*
calendar date for the caller. It exists so that "what did I actually do on the 12th?" has a
single authoritative answer instead of one ad-hoc query per screen.

| Column | Source |
| --- | --- |
| `missions_total` / `completed` / `skipped` / `blocked` / `open` | `daily_missions` rows with that `mission_date` |
| `habits_expected` | habits that existed that day (from `created_at` / `archived_at`) and were scheduled for it |
| `habits_logged` | `habit_logs` marked completed for that date |
| `xp_awarded` / `xp_adjusted` / `xp_net` | the ledger, bucketed by the **local date of `awarded_at`** |
| `achievements_unlocked` | `player_achievements` unlocked on that local date |

Two consequences are deliberate:

- **XP belongs to the day it was recorded.** Backfilling a habit from three weeks ago adds
  its log to *that* day but its XP to *today* — the ledger stays append-only, so a finished
  review is never rewritten.
- **A day with no rows is a real answer** (zeros), not an error. An unrecognised time zone,
  by contrast, raises, so a typo cannot silently report the wrong day.

The screen `/review?date=` renders this row verbatim and computes nothing; the clamp that
stops a review looking into the future lives in `src/lib/review.ts` and is unit-tested.

Since Stage C, `day_summary` is literally the single-day case of `analytics_range` (§8.2),
so the rules in the table above are shared by both entry points and cannot drift.

Focus time on the same day comes from `focus_summary(p_date, p_time_zone)`, which follows
the same local-day rule: a session belongs to the day it started on, an open session is
reported as open and counts zero, and only a session ended as `completed` contributes
seconds. The review screen lists the sessions beside the totals, so a discarded one is
visibly a record and not a number.

## 8. Action history and analytics

Two questions had no single authority: *"what happened, in order?"* and *"how did the
last N days actually go?"* Stage C adds one append-only store and one range read model.

### 8.1 The action log

`action_log` records only the transitions that **no other table keeps**:

| Event | Why it is not derivable |
| --- | --- |
| `mission_created` / `mission_deleted` | deleting a mission takes its row (and every trace of it) away |
| `mission_status_changed` | only the *current* status is stored; a skip → undo → skip sequence was lost |
| `habit_created` / `habit_archived` / `habit_restored` / `habit_deleted` | `archived_at` holds only the latest value |
| `habit_logged` / `habit_unlogged` | `habit_logs.completed` holds only the latest value |
| `time_zone_changed` | `profiles.time_zone` is overwritten; the previous zone was lost |

Events that already have an authoritative store are deliberately **not** copied in:
focus sessions (`focus_sessions`), quest step completions (`quest_steps.completed_at`),
achievement unlocks (`player_achievements`) and XP (`xp_ledger`). The log stores a
`subject`/`subject_id` pointer plus content-free context — status values, calendar dates
and zone names. Titles, notes, outcomes, reasons and evidence never enter it.
`action_history` resolves the subject's *current* name under RLS at read time; a deleted
subject simply has no name left to show. No backfill is attempted: the log starts with
the migration that introduced it, and the screens say so.

**Write path.** Security-definer triggers on `daily_missions`, `habits`, `habit_logs` and
`profiles` write the rows, so a future write path cannot forget to log. They compare with
`is distinct from`, so an idempotent `set_mission_status` / `log_habit` call cannot produce
a duplicate event, and plan edits or reorders are not events. Clients hold SELECT only; an
immutability trigger refuses updates and direct deletes. The one exception is a cascaded
account deletion — the trigger recognises a foreign-key cascade (`pg_trigger_depth() > 1`)
and the writers refuse to record an event for a user that no longer exists — so removing
an account removes its private history instead of failing.

### 8.2 The range read model

`analytics_range(p_from, p_to, p_time_zone)` returns one row per **local calendar day**,
ascending, including days with no records at all. Each rule is the one §7 documents:
`mission_date` is already local; XP is bucketed by the local day `awarded_at` was written
on; a focus session belongs to the day it started, and only a completed session contributes
seconds; habits expected are reconstructed from `created_at` / `archived_at` plus the
weekday schedule; step completions and achievements are bucketed by the local day recorded.
The span is capped at 366 days, both dates are required, and the zone is validated against
`pg_timezone_names`.

`xp_by_source` groups the ledger by source into awards, adjustments and net, so a
correction stays visible under the source it corrected. A discarded session is counted as
started (`focus_sessions`) but never as focused time, and a reopened mission is not
completed because its stored status is not `completed`.

`src/lib/analytics.ts` is the only place that adds these rows up (`sumDays`), turns them
into relative bars (`trendBars`), derives a percentage (`rate`, which returns `null` when
there is no denominator rather than a fake zero) and describes an event (`describeAction`).
The Command Center shows a 14-day trend, 7-day totals, the XP sources and recent activity;
the day review shows the seven days ending on that date and the events recorded on it.

## 9. Authorization

- Every table used by a user is protected by **row level security** tied to `auth.uid()`.
- `player_stats`, `level_history` and `quest_progress` are `security_invoker` views: they
  run with the caller's own permissions, so RLS still applies. Their counts are
  correlated to `profiles.id` (not `auth.uid()`) so they are correct both under RLS and
  inside a `security definer` function.
- Privileged operations are `security definer` functions with an explicit
  `search_path = public`; `execute` is granted to `authenticated` only.
- Where a client genuinely edits rows (a mission plan, a quest title, a display name),
  the permission is granted **per column**, so the columns that carry meaning (`status`,
  `completed_at`, `outcome`, `time_zone`, `user_id`, `position`) stay writable only through
  the routines that own them. Ordering therefore runs through `reorder_missions()`, never
  through a plain `update`.
- `focus_sessions` is **SELECT-only** for clients: writes are the two focus RPCs. That is a
  privilege restriction as well as a policy choice, so a crafted request cannot bypass the
  one-open-session rule or backdate a start.
- `action_log` and its read views are **SELECT-only** for clients: the log has no
  insert/update/delete policy, the trigger functions that write it are `security definer`
  and revoked, and an immutability trigger refuses direct mutation.

## 10. Achievements

`sync_achievements()` is idempotent and re-runnable. It reads the canonical
`player_stats` snapshot, inserts any newly earned rows into `player_achievements`
(`on conflict do nothing`), and awards XP through `award_xp` keyed on a **deterministic**
`source_id` (`deterministic_uuid(user:achievement)`), so a re-run can never double-award.
The TS catalogue in `src/lib/progression.ts` is display metadata; the SQL function is the
authority.

## 11. Money (prepared, not yet wired)

`src/lib/finance.ts` stores money as **integer minor units + ISO-4217 code** and never
uses binary floating point. `parseMoney`/`toDecimalString` are exact, currency exponents
(JPY = 0, KWD = 3 …) are honoured, and `budgetUsage` avoids divide-by-zero. The matching
SQL storage convention is `numeric`/`bigint` minor units. No table or screen uses it yet.

## 12. Testing strategy

| Layer | How it is verified |
| --- | --- |
| Pure domain | Vitest unit tests (`src/lib/*.test.ts`) |
| SQL engine | `npm run db:test` — all migrations applied to a throwaway Postgres container, then `supabase/tests/*.sql` assertions |
| Integration | `npm run build` must succeed and app routes must build as dynamic |
| Lint/types | `npm run lint`, `npm run typecheck` |

The SQL harness is the important one: it is what caught the broken
`complete_quest_step`, the non-replayable migration sequence, the missing XP restore and
the fact that a future habit day could be logged for XP. New SQL behaviour is expected to
arrive with an assertion in `supabase/tests/10_engine_assertions.sql`.
