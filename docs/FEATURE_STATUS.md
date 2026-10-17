# LEVI OS — Feature Status

Honest, per-feature status. **Statuses:** ✅ verified · 🟡 partial · ⏭ not started.
"Verified" means there is a command or route that was actually exercised — not that the
code merely exists.

_Last verified: 2026-10-18. Commands: `npm run lint` · `npm run typecheck` · `npm test`
(89 passed) · `npm run db:test` (10 migrations, 160 assertions) · `npm run build`._

## Foundation

| Feature | Status | Evidence / notes |
| --- | --- | --- |
| Next.js 16 App Router + TypeScript | ✅ | `npm run build` succeeds |
| Tailwind v4 + design tokens | ✅ | `src/app/globals.css` (dark-first, light counterpart, reduced-motion) |
| Supabase client/server adapters | ✅ | `src/lib/supabase/{client,server}.ts` |
| Magic-link auth | ✅ | `src/app/login/page.tsx`, `/auth/callback`; session-guarded layout |
| Sign out | ✅ | `POST /auth/signout` → redirect `/login` (POST only, never GET) |
| Unconfigured setup notice | ✅ | `ConfigurationNotice` instead of a crash |
| Error boundary + retry | ✅ | `src/app/(app)/error.tsx` |
| Loading skeleton | ✅ | `src/app/(app)/loading.tsx` |

## Progression

| Feature | Status | Evidence / notes |
| --- | --- | --- |
| XP ledger (append-only) | ✅ | assertions: _"the XP ledger is append-only"_, _"clients cannot insert XP ledger rows"_ |
| Idempotent awards | ✅ | `unique (user_id, source, source_id)`; _"completing twice never double-awards"_ |
| Auditable corrections | ✅ | balanced adjustments; _"the reopen appends an auditable adjustment instead of deleting history"_ |
| Level formula (TS + SQL) | ✅ | `progression.test.ts`; _"player stats level is 3 at 1250 XP"_ |
| XP history view | ✅ | `level_history`; rendered on the Command Center |
| Achievements | ✅ | `sync_achievements`; _"re-running achievement sync unlocks nothing new"_ |
| Canonical player stats | ✅ | `player_stats`; _"a new user starts at 0 XP"_ |

## Quests

| Feature | Status | Evidence / notes |
| --- | --- | --- |
| Main quests / subquests / steps | ✅ | `/quests` |
| Evidence-backed step completion | ✅ | `complete_quest_step` (previously broken — see audit §4.1) |
| Rewards on completion | ✅ | 250 XP subquest, 1000 XP main quest |
| Derived progress + status | ✅ | `quest_progress` (security_invoker), read-only in the UI |
| Replayable migrations | ✅ | `db:test` applies all ten in order (previously failed — audit §4.2) |

## Daily loop

| Feature | Status | Evidence / notes |
| --- | --- | --- |
| Daily missions with priorities/estimates | ✅ | `/missions` |
| State machine via RPC only | ✅ | no table-wide `update` on `daily_missions`; plan columns are granted per column |
| Edit a mission plan | ✅ | column-level grant; _"a client can edit a planned mission"_ |
| Reasons required to skip/block | ✅ | constraint + action validation |
| Mission XP (+50) and reversal | ✅ | reopen removes, re-complete restores (audit §4.3) |
| Mission undo (skip/block → planned) | ✅ | "Undo" action; the reason is retracted, because the mission was not really skipped |
| Persistent mission order (↑ / ↓) | ✅ | `moveMission` → `reorder_missions`; the whole day is rebuilt server-side and positions become `0..n-1` |
| Invalid orders rejected | ✅ | assertions for duplicates, a partial list, a null entry, another day's mission and another user's mission |
| Order survives a refresh | ✅ | `getMissionsForDate` orders by `(position, created_at)`; `/missions` and the Command Center's "next up" use it |
| Priority is a label, not the order | ✅ | the open list is the user's saved order; priority is shown as a badge on the card |
| Habits with weekday schedules | ✅ | `/habits` |
| Habit logs (SELECT-only for clients) | ✅ | `log_habit` RPC; _"clients cannot write habit logs directly"_ |
| Streaks (current/longest) | ✅ | `habit_summary`; Mon/Wed/Fri case asserted |
| 30-day consistency | ✅ | `src/lib/habits.ts`; shown on each habit card |
| Archive / restore habit | ✅ | `archived_at`, history and XP preserved |
| Undo a logged day | ✅ | "Undo today" action; XP removed, not duplicated |
| Backfill a past habit day | ✅ | "Backfill another day" control; one row and one award per day |
| Future habit days refused | ✅ | database guard against the caller's local today; _"a future habit day is rejected"_

## Focus

| Feature | Status | Evidence / notes |
| --- | --- | --- |
| Start / end a session | ✅ | `/focus`; `start_focus_session` / `end_focus_session` are the only write paths |
| One running session per user | ✅ | partial unique index `(user_id) where ended_at is null`; _"the one running session rule is a real unique index"_ |
| Duration from server timestamps | ✅ | `focus_session_log.elapsed_seconds` = `ended_at − started_at`; no client number participates |
| Interrupted sessions | ✅ | **Discard** keeps the row with `ended_reason = 'discarded'` and counts no time; the UI warns after 12 h (`focus.ts`, tested) |
| Double end is harmless | ✅ | idempotent: _"ending an already-ended session is a no-op that reports the truth"_ |
| No XP | ✅ | _"focus sessions award no XP and write nothing to the ledger"_ |
| Day attribution | ✅ | a session belongs to the local day it started on, even across midnight; `focus_summary(date, time_zone)` |
| Read-only for clients | ✅ | SELECT-only grant; assertions for direct insert / update / delete |
| Optional mission link, owned | ✅ | checked in the RPC **and** a trigger; a link never completes the mission |

## Day review

| Feature | Status | Evidence / notes |
| --- | --- | --- |
| One finished day, end to end | ✅ | `/review?date=` renders `day_summary(date, time_zone)` |
| XP awarded / adjusted / net | ✅ | the ledger, bucketed by the local date of `awarded_at` |
| Missions by status | ✅ | counted from `daily_missions` rows with a reason or an outcome shown |
| Habits logged vs expected | ✅ | expected is reconstructed from `created_at` / `archived_at` + schedule |
| Achievements unlocked that day | ✅ | from `player_achievements` |
| Focus sessions on the day | ✅ | `focus_summary` + `focus_session_log`; discarded sessions are listed but not counted |
| Cannot look into the future | ✅ | `resolveReviewDate` clamps to today; `src/lib/review.test.ts` |
| Date navigation | ✅ | previous / next / today + a date picker (`max` = today) |
| Seven-day context | ✅ | `analytics_range` for the 14 days ending on the reviewed date; last seven and previous seven shown side by side |
| Activity recorded that day | ✅ | `action_history` filtered by its derived local day; an empty state says the log is not retroactive |
| Read-only by design | ✅ | resolving work stays on `/missions` and `/habits`, which it links to |

## Analytics and action history

| Feature | Status | Evidence / notes |
| --- | --- | --- |
| Append-only action log | ✅ | `action_log`; SELECT-only + RLS, immutability trigger; _"the action log is append-only"_, _"a direct delete … is refused"_ |
| Mission lifecycle events | ✅ | create / status / delete triggers; _"every real status transition is recorded exactly once"_, _"editing a plan is not a history event"_ |
| Habit log corrections + archive | ✅ | logged / un-logged / archived / restored / deleted; _"a habit day logged, un-logged and logged again leaves three events, not five"_ |
| Time-zone changes | ✅ | old and new zone recorded once; _"the time-zone event names both the previous zone and the new one"_ |
| No second XP ledger | ✅ | the log stores no amounts and is never consulted for XP; `xp_ledger` remains the only ledger |
| No duplication of authoritative events | ✅ | focus sessions, quest steps, achievements and XP are read from their own tables — never copied into the log |
| Private by default | ✅ | own-rows RLS on `action_log` / `action_history`; _"another user's action history is invisible"_ |
| Account deletion cascade | ✅ | a removed account takes its private history; _"removing an account removes its private history instead of blocking the delete"_ |
| One range read model | ✅ | `analytics_range(from, to, tz)`; `day_summary` is its single-day case; 366-day cap and input guards |
| Local-day correctness | ✅ | XP bucketed by local `awarded_at`; _"an XP entry belongs to the local day it was written on"_ |
| Trends that cannot lie | ✅ | discarded focus adds no time, reopened missions are not completed, zero days are real rows not gaps |
| XP by source | ✅ | `xp_by_source` (awards / adjustments / net per source) |
| Weekly comparison | ✅ | last seven vs previous seven on `/review`, computed by `sumDays` |
| Empty / loading / error states | ✅ | route skeleton + error boundary; explicit empty states on both new panels |

## Command Center

| Feature | Status | Evidence / notes |
| --- | --- | --- |
| Real XP / level / progress | ✅ | `/dashboard` (dynamic route) |
| Today's missions + carried-over work | ✅ | `/dashboard`, `/missions` |
| Habits due vs logged today | ✅ | local-date aware |
| Active quests with progress | ✅ | from `quest_progress` |
| Recent XP ledger entries | ✅ | from `level_history` |
| 14-day momentum + 7-day totals | ✅ | `analytics_range`; net-XP bars, missions, focus, habits, achievements |
| XP by source | ✅ | `xp_by_source`, read from the append-only ledger |
| Recent action history | ✅ | `action_history`; its empty state says the log is not retroactive |
| Achievement gallery | ✅ | from `achievements` + `player_achievements` |
| No mock/preview data anywhere | ✅ | app routes build as `ƒ`; empty states used |

## Settings

| Feature | Status | Evidence / notes |
| --- | --- | --- |
| Display name | ✅ | `saveDisplayName` |
| Time zone (validated server-side) | ✅ | `set_time_zone` against `pg_timezone_names`; a direct `profiles.time_zone` write is rejected by privilege |
| Local "today" shown | ✅ | from `getSessionContext()` |

## Prepared but not wired

| Feature | Status | Notes |
| --- | --- | --- |
| Money engine | 🟡 | `src/lib/finance.ts` tested (11 tests); **no table or screen yet** |
| Domain aliases (`src/types/domain.ts`) | 🟡 | legacy duplicate of schema types; safe to retire when unused |

## Not started (roadmap — see `docs/IMPLEMENTATION_PLAN.md`)

| Feature | Status | Blocked by |
| --- | --- | --- |
| Remote Supabase push + production smoke test | 🔒 ⏭ | project owner (credentials, live data) |
| Journal, weekly/monthly reviews | ⏭ | stage D |
| Scripture and prayer journal | ⏭ | stage D (journal kinds) |
| Career and learning module | 🟡 | modelable on quests today; module in stage E |
| Knowledge library | ⏭ | stage E |
| Finance (accounts, transactions, budgets) | 🟡 | engine tested; tables/UI in stage F |
| Read-only AI advisor | 🔒 ⏭ | stage F (needs a provider key; read-only half can ship first) |

## Known limitations

- The Supabase migrations have **not** been applied to the remote project; the remote
  schema is unknown. Nothing here asserts the remote state.
- **Authenticated UI flows are not exercised by the repository's checks.** Focus sessions,
  mission ordering, the day review, the analytics panels and the action history are asserted
  at the database level and their routes build as dynamic, but no signed-in click-through is
  performed here (there is no test account or local auth stack). That verification is
  owner-run — see `docs/IMPLEMENTATION_PLAN.md` Part 4.
- **The action history is not retroactive.** It records events from the migration that
  introduced it onward. Nothing before that was stored, so neither the log nor the charts
  pretend to reconstruct it; an older day legitimately shows "nothing recorded".
- Auth email delivery depends on the Supabase project's configuration and cannot be
  verified from the repository.
- `AGENTS.md` / `CLAUDE.md` are generated/maintained tooling notes at the repo root and
  are not part of LEVI OS runtime behaviour.
