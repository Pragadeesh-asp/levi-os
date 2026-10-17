-- ===========================================================================
-- Stage C — action history and analytics read models
--
-- Two questions the engine could not answer:
--
--  1. "What actually happened, in order?" The ledger records XP events and
--     focus_sessions records time, but a mission that was skipped and then
--     un-skipped leaves no trace at all, and nothing records a habit
--     correction, an archive, or a time-zone change. This adds `action_log`:
--     an append-only record of the transitions that have no other authoritative
--     store. Events that already live elsewhere (focus sessions, quest steps,
--     achievement unlocks, XP) are deliberately NOT copied into it — the log
--     keeps a pointer and the screen reads the authoritative row.
--
--  2. "How did the last N days actually go?" `day_summary` answers one day at a
--     time. `analytics_range` answers the same question for a span of local
--     days, and `day_summary` is re-expressed as its single-day case, so the two
--     definitions can never drift apart.
--
-- Additive and non-destructive: no existing row is rewritten, no awarded XP is
-- touched, and no table or column is dropped. The log starts recording with this
-- migration — it can never reconstruct a change that was not stored before it,
-- and the screens say so.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. action_log — append-only, private, and content-free
-- ---------------------------------------------------------------------------
create table if not exists public.action_log (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  occurred_at timestamptz not null default now(),
  kind text not null check (kind in (
    'mission_created', 'mission_status_changed', 'mission_deleted',
    'habit_created', 'habit_archived', 'habit_restored', 'habit_deleted',
    'habit_logged', 'habit_unlogged',
    'time_zone_changed'
  )),
  subject text not null check (subject in ('mission', 'habit', 'profile')),
  -- What the event is about. Deliberately NOT a foreign key: a deleted mission
  -- must stay auditable, and the deletion of the row is itself an event. A
  -- dangling id is shown as "no longer exists", never invented back.
  subject_id uuid not null,
  -- Structured, content-free context: status values, calendar dates and time
  -- zone names only. Titles, notes, outcomes, reasons and evidence never enter
  -- the log — the history names its subject by joining the live row, scoped by
  -- RLS, at read time.
  detail jsonb not null default '{}'::jsonb check (jsonb_typeof(detail) = 'object')
);

create index if not exists action_log_user_time_idx
  on public.action_log(user_id, occurred_at desc, id desc);
create index if not exists action_log_subject_idx
  on public.action_log(user_id, subject, subject_id);

-- The log is append-only for everyone: a correction is a new event, never a
-- rewritten one (the same rule the XP ledger lives by). The one exception is a
-- *cascaded* delete from `auth.users` — the account itself is being removed, so
-- its private history goes with it. A direct delete is still refused; a direct
-- statement runs this trigger at depth 1, a foreign-key cascade at depth 2.
create or replace function public.assert_action_log_immutable()
returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then
    return old;
  end if;
  raise exception 'Action history rows cannot be updated or deleted';
end;
$$;
revoke all on function public.assert_action_log_immutable() from public, anon, authenticated;

drop trigger if exists action_log_immutable on public.action_log;
create trigger action_log_immutable
  before update or delete on public.action_log
  for each row execute procedure public.assert_action_log_immutable();

alter table public.action_log enable row level security;

drop policy if exists "action log select own" on public.action_log;
create policy "action log select own" on public.action_log
  for select to authenticated using ((select auth.uid()) = user_id);

-- Read-only for clients: the only writer is the trigger set below, running as
-- the table owner. There is deliberately no insert/update/delete policy.
grant select on public.action_log to authenticated;
revoke insert, update, delete on public.action_log from anon, authenticated;
revoke references, trigger, truncate on public.action_log from anon, authenticated;
revoke all on sequence public.action_log_id_seq from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. The writers — one trigger per write path that has something to record
--
--    These run as the table owner (security definer) so a client never needs a
--    write grant on the log, and they run *after* the row changed, so the event
--    is only ever written for a change that really happened. Every function
--    refuses to record an event for a user that no longer exists, which is what
--    makes deleting an account (a cascade) safe.
-- ---------------------------------------------------------------------------
create or replace function public.record_mission_action()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_user_id uuid := case when tg_op = 'DELETE' then old.user_id else new.user_id end;
begin
  if not exists (select 1 from auth.users u where u.id = v_user_id) then
    return coalesce(new, old);
  end if;

  if tg_op = 'INSERT' then
    insert into public.action_log (user_id, kind, subject, subject_id, detail)
    values (v_user_id, 'mission_created', 'mission', new.id,
            jsonb_build_object('mission_date', new.mission_date::text, 'status', new.status::text));
  elsif tg_op = 'UPDATE' then
    -- `set_mission_status` always writes the status column, even when the value
    -- does not change; an idempotent call must not produce a duplicate event.
    if new.status is distinct from old.status then
      insert into public.action_log (user_id, kind, subject, subject_id, detail)
      values (v_user_id, 'mission_status_changed', 'mission', new.id,
              jsonb_build_object('from', old.status::text, 'to', new.status::text));
    end if;
  else
    insert into public.action_log (user_id, kind, subject, subject_id, detail)
    values (v_user_id, 'mission_deleted', 'mission', old.id,
            jsonb_build_object('mission_date', old.mission_date::text, 'status', old.status::text));
  end if;
  return coalesce(new, old);
end;
$$;
revoke all on function public.record_mission_action() from public, anon, authenticated;

drop trigger if exists daily_missions_log_action on public.daily_missions;
create trigger daily_missions_log_action
  after insert or update of status or delete on public.daily_missions
  for each row execute procedure public.record_mission_action();

create or replace function public.record_habit_action()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_user_id uuid := case when tg_op = 'DELETE' then old.user_id else new.user_id end;
begin
  if not exists (select 1 from auth.users u where u.id = v_user_id) then
    return coalesce(new, old);
  end if;

  if tg_op = 'INSERT' then
    insert into public.action_log (user_id, kind, subject, subject_id, detail)
    values (v_user_id, 'habit_created', 'habit', new.id, '{}'::jsonb);
  elsif tg_op = 'DELETE' then
    insert into public.action_log (user_id, kind, subject, subject_id, detail)
    values (v_user_id, 'habit_deleted', 'habit', old.id, '{}'::jsonb);
  elsif new.archived_at is distinct from old.archived_at then
    insert into public.action_log (user_id, kind, subject, subject_id, detail)
    values (v_user_id,
            case when new.archived_at is null then 'habit_restored' else 'habit_archived' end,
            'habit', new.id, '{}'::jsonb);
  end if;
  return coalesce(new, old);
end;
$$;
revoke all on function public.record_habit_action() from public, anon, authenticated;

drop trigger if exists habits_log_action on public.habits;
create trigger habits_log_action
  after insert or update of archived_at or delete on public.habits
  for each row execute procedure public.record_habit_action();

create or replace function public.record_habit_log_action()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_user_id uuid;
begin
  -- A log row has no user of its own; the habit is the owner.
  select h.user_id into v_user_id from public.habits h where h.id = new.habit_id;
  if v_user_id is null or not exists (select 1 from auth.users u where u.id = v_user_id) then
    return new;
  end if;

  -- `log_habit` always writes the completed flag; an idempotent call that did
  -- not change the day's state is not an event.
  if tg_op = 'UPDATE' and new.completed is not distinct from old.completed then
    return new;
  end if;

  insert into public.action_log (user_id, kind, subject, subject_id, detail)
  values (v_user_id,
          case when new.completed then 'habit_logged' else 'habit_unlogged' end,
          'habit', new.habit_id,
          jsonb_build_object('log_date', new.log_date::text));
  return new;
end;
$$;
revoke all on function public.record_habit_log_action() from public, anon, authenticated;

drop trigger if exists habit_logs_log_action on public.habit_logs;
create trigger habit_logs_log_action
  after insert or update of completed on public.habit_logs
  for each row execute procedure public.record_habit_log_action();

create or replace function public.record_time_zone_change()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.time_zone is not distinct from old.time_zone then
    return new;
  end if;
  if not exists (select 1 from auth.users u where u.id = new.id) then
    return new;
  end if;

  insert into public.action_log (user_id, kind, subject, subject_id, detail)
  values (new.id, 'time_zone_changed', 'profile', new.id,
          jsonb_build_object('from', old.time_zone, 'to', new.time_zone));
  return new;
end;
$$;
revoke all on function public.record_time_zone_change() from public, anon, authenticated;

drop trigger if exists profiles_log_time_zone on public.profiles;
create trigger profiles_log_time_zone
  after update of time_zone on public.profiles
  for each row execute procedure public.record_time_zone_change();

-- ---------------------------------------------------------------------------
-- 3. action_history — the log, readable, in the caller's own local days
-- ---------------------------------------------------------------------------
create or replace view public.action_history with (security_invoker = true) as
select
  a.id,
  a.user_id,
  a.occurred_at,
  -- The local day the event happened on, using the caller's stored zone — the
  -- same rule as focus_session_log. A zone change dates later events correctly;
  -- the day an old event is shown under is always derived, never stored.
  (a.occurred_at at time zone p.time_zone)::date as occurred_on,
  a.kind,
  a.subject,
  a.subject_id,
  a.detail,
  -- The subject's *current* name, resolved live under RLS. Never stored in the
  -- log: a mission renamed tomorrow must not rewrite yesterday's event, and a
  -- deleted subject simply has no name left to show.
  coalesce(m.title, h.name) as subject_label
from public.action_log a
join public.profiles p on p.id = a.user_id
left join public.daily_missions m on a.subject = 'mission' and m.id = a.subject_id
left join public.habits h on a.subject = 'habit' and h.id = a.subject_id;

grant select on public.action_history to authenticated;
revoke insert, update, delete on public.action_history from anon, authenticated;
revoke references, trigger, truncate on public.action_history from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. analytics_range(from, to, time_zone) — the same day, for many local days
--
--    One row per local calendar day in the span, ascending, including days with
--    no records at all (a real answer of zeros, not an error and not a gap).
--    Every rule matches `day_summary`, which is re-expressed below as the
--    p_from = p_to case of this function, so the two can never disagree:
--      * a mission belongs to its `mission_date` (already a local date);
--      * XP belongs to the local day `awarded_at` was written on — history is
--        never retroactively rewritten by a backfilled log;
--      * a focus session belongs to the local day it *started* on, and only an
--        ended, non-discarded session contributes seconds;
--      * habits expected on a day are reconstructed from created_at/archived_at
--        and the weekday schedule;
--      * achievements and quest steps are bucketed by the local day they were
--        recorded on.
--    A span is capped at 366 days so a stray URL cannot ask for a decade.
-- ---------------------------------------------------------------------------
create or replace function public.analytics_range(p_from date, p_to date, p_time_zone text)
returns table (
  day date,
  xp_awarded bigint,
  xp_adjusted bigint,
  xp_net bigint,
  missions_total integer,
  missions_completed integer,
  missions_skipped integer,
  missions_blocked integer,
  missions_open integer,
  habits_expected integer,
  habits_logged integer,
  steps_completed integer,
  focus_sessions integer,
  focus_completed integer,
  focus_seconds bigint,
  achievements_unlocked integer
)
language plpgsql stable set search_path = public as $$
declare
  v_user_id uuid := auth.uid();
begin
  if p_from is null or p_to is null then
    raise exception 'A range needs two calendar dates';
  end if;
  if p_to < p_from then
    raise exception 'A range must end on or after it starts';
  end if;
  if p_to - p_from > 365 then
    raise exception 'A range can cover at most 366 days';
  end if;
  if p_time_zone is null or not exists (select 1 from pg_timezone_names z where z.name = p_time_zone) then
    raise exception '"%" is not a recognized IANA time zone', coalesce(p_time_zone, 'null');
  end if;

  -- No session: no days to summarise.
  if v_user_id is null then
    return;
  end if;

  return query
  with days as (
    select d::date as day from generate_series(p_from, p_to, interval '1 day') d
  ), missions as (
    select m.mission_date as day,
      count(*)::integer as total,
      count(*) filter (where m.status = 'completed')::integer as completed,
      count(*) filter (where m.status = 'skipped')::integer as skipped,
      count(*) filter (where m.status = 'blocked')::integer as blocked,
      count(*) filter (where m.status in ('planned', 'active'))::integer as open
    from public.daily_missions m
    where m.user_id = v_user_id
      and m.mission_date between p_from and p_to
    group by m.mission_date
  ), expected as (
    select d.day, count(h.id)::integer as total
    from days d
    join public.habits h
      on h.user_id = v_user_id
      and (h.created_at at time zone p_time_zone)::date <= d.day
      and (h.archived_at is null or (h.archived_at at time zone p_time_zone)::date > d.day)
      and (h.schedule_weekdays is null
           or extract(isodow from d.day)::smallint = any(h.schedule_weekdays))
    group by d.day
  ), logged as (
    select l.log_date as day, count(*)::integer as total
    from public.habit_logs l
    join public.habits h on h.id = l.habit_id
    where h.user_id = v_user_id
      and l.log_date between p_from and p_to
      and l.completed
    group by l.log_date
  ), xp_days as (
    select (x.awarded_at at time zone p_time_zone)::date as day,
      coalesce(sum(x.amount) filter (where x.amount > 0), 0)::bigint as awarded,
      coalesce(sum(x.amount) filter (where x.amount < 0), 0)::bigint as adjusted,
      coalesce(sum(x.amount), 0)::bigint as net
    from public.xp_ledger x
    where x.user_id = v_user_id
      and (x.awarded_at at time zone p_time_zone)::date between p_from and p_to
    group by 1
  ), steps as (
    select (s.completed_at at time zone p_time_zone)::date as day, count(*)::integer as total
    from public.quest_steps s
    join public.quests q on q.id = s.quest_id
    where q.user_id = v_user_id
      and s.completed_at is not null
      and (s.completed_at at time zone p_time_zone)::date between p_from and p_to
    group by 1
  ), focus as (
    select (f.started_at at time zone p_time_zone)::date as day,
      count(*)::integer as sessions,
      count(*) filter (where f.ended_reason = 'completed')::integer as completed,
      coalesce(
        sum(greatest(0, floor(extract(epoch from (f.ended_at - f.started_at)))))
          filter (where f.ended_reason = 'completed'),
        0
      )::bigint as seconds
    from public.focus_sessions f
    where f.user_id = v_user_id
      and (f.started_at at time zone p_time_zone)::date between p_from and p_to
    group by 1
  ), unlocked as (
    select (pa.unlocked_at at time zone p_time_zone)::date as day, count(*)::integer as total
    from public.player_achievements pa
    where pa.user_id = v_user_id
      and (pa.unlocked_at at time zone p_time_zone)::date between p_from and p_to
    group by 1
  )
  select
    d.day,
    coalesce(x.awarded, 0), coalesce(x.adjusted, 0), coalesce(x.net, 0),
    coalesce(m.total, 0), coalesce(m.completed, 0), coalesce(m.skipped, 0), coalesce(m.blocked, 0), coalesce(m.open, 0),
    coalesce(e.total, 0), coalesce(l.total, 0),
    coalesce(s.total, 0),
    coalesce(f.sessions, 0), coalesce(f.completed, 0), coalesce(f.seconds, 0),
    coalesce(u.total, 0)
  from days d
  left join missions m on m.day = d.day
  left join expected e on e.day = d.day
  left join logged l on l.day = d.day
  left join xp_days x on x.day = d.day
  left join steps s on s.day = d.day
  left join focus f on f.day = d.day
  left join unlocked u on u.day = d.day
  order by d.day;
end;
$$;
revoke all on function public.analytics_range(date, date, text) from public, anon;
grant execute on function public.analytics_range(date, date, text) to authenticated;

-- `day_summary` is now exactly the single-day case of the range: one definition
-- of every rule, two entry points. The validations (and their messages) are kept
-- where they were so existing callers see no change.
create or replace function public.day_summary(p_date date, p_time_zone text)
returns table (
  missions_total integer,
  missions_completed integer,
  missions_skipped integer,
  missions_blocked integer,
  missions_open integer,
  habits_expected integer,
  habits_logged integer,
  xp_awarded bigint,
  xp_adjusted bigint,
  xp_net bigint,
  achievements_unlocked integer
)
language plpgsql stable set search_path = public as $$
declare
  v_user_id uuid := auth.uid();
begin
  if p_date is null then
    raise exception 'A day summary needs a calendar date';
  end if;

  if p_time_zone is null or not exists (select 1 from pg_timezone_names z where z.name = p_time_zone) then
    raise exception '"%" is not a recognized IANA time zone', coalesce(p_time_zone, 'null');
  end if;

  -- No session: no rows to summarise.
  if v_user_id is null then
    return;
  end if;

  return query
  select r.missions_total, r.missions_completed, r.missions_skipped, r.missions_blocked, r.missions_open,
         r.habits_expected, r.habits_logged, r.xp_awarded, r.xp_adjusted, r.xp_net, r.achievements_unlocked
  from public.analytics_range(p_date, p_date, p_time_zone) r;
end;
$$;
revoke all on function public.day_summary(date, text) from public, anon;
grant execute on function public.day_summary(date, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. xp_by_source — where the XP actually comes from, per module
--
--    A read model over the append-only ledger: awards, adjustments and the net
--    per source. An adjustment inherits the source of the award it corrects, so
--    a corrected mission completion still reports under `daily_mission`.
-- ---------------------------------------------------------------------------
create or replace view public.xp_by_source with (security_invoker = true) as
select
  x.user_id,
  x.source,
  coalesce(sum(x.amount) filter (where x.amount > 0), 0)::bigint as awarded,
  coalesce(sum(x.amount) filter (where x.amount < 0), 0)::bigint as adjusted,
  coalesce(sum(x.amount), 0)::bigint as net,
  count(*)::integer as entries
from public.xp_ledger x
group by x.user_id, x.source;

grant select on public.xp_by_source to authenticated;
revoke insert, update, delete on public.xp_by_source from anon, authenticated;
revoke references, trigger, truncate on public.xp_by_source from anon, authenticated;
