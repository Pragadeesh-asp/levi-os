-- ===========================================================================
-- Quest-core reconciliation (forward-only).
--
-- Aligns a phase-1/phase-2-era database (initial_core + quest_engine + a
-- partial phase-2 pass) with the final quest-core behavior defined by this
-- migration chain:
--
--   * complete_quest_step: 1..4,000-character evidence validation and a
--     consistent parent -> quest -> step lock order
--   * award_completed_quest_xp: FOR UPDATE serialization so concurrent
--     completions cannot both observe an incomplete sibling and silently miss
--     an eligible award; the unique ledger constraint keeps awards exactly-once
--   * parent-aware delete protection, post-award structure freezing, quest
--     identity immutability and xp_ledger immutability
--   * step-position serialization and steps-only-on-subquests enforcement
--   * operation-specific RLS policies. The quests delete policy checks
--     ownership only; awarded quests are refused by a SECURITY DEFINER trigger,
--     so the policy never depends on EXECUTE rights for a helper that is
--     revoked from clients (RLS expressions run with the caller's privileges)
--   * column-level least privilege for quests / quest_steps / xp_ledger
--   * the canonical quest_progress view with security_invoker = true
--
-- Functions are (re)created with `search_path = ''` and fully-qualified
-- references, preserving the setting the existing remote functions use. This
-- migration is re-runnable: it is safe against the partial pre-phase-2 state,
-- against a fresh application of the chain, and against the fully migrated
-- local chain. It never rewrites client data and leaves default privileges
-- untouched. Apply it as a single transaction.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Evidence constraint: cap evidence at 4,000 characters (the pre-phase-2
-- state only enforces non-empty evidence). Rows that violate the cap abort
-- the migration instead of being rewritten.
-- ---------------------------------------------------------------------------
alter table public.quest_steps
  drop constraint if exists quest_steps_check;
alter table public.quest_steps
  add constraint quest_steps_check check (
    (completed_at is null and evidence_type is null and evidence_value is null)
    or (
      completed_at is not null
      and evidence_type is not null
      and char_length(trim(coalesce(evidence_value, ''))) between 1 and 4000
    )
  );

-- ---------------------------------------------------------------------------
-- XP ledger idempotency: exactly-once awards rest on a unique
-- (user_id, source, source_id) constraint. Establish it only when an
-- equivalent unique index is absent, and fail without touching any data when
-- duplicates would make it impossible. Equivalence compares the key columns
-- only (`indkey` is 0-based; its first `indnkeyatts` entries are the keys), so
-- a unique index that merely carries INCLUDE columns is recognised — award
-- inserts infer their ON CONFLICT arbiter from it — while an index whose key
-- columns are a subset of the targets is not.
-- ---------------------------------------------------------------------------
do $$
declare
  v_has_unique boolean;
begin
  select exists (
    select 1
    from pg_index i
    where i.indrelid = 'public.xp_ledger'::regclass
      and i.indisunique
      and i.indisvalid
      and i.indisready
      and i.indpred is null
      and i.indexprs is null
      and i.indnkeyatts = 3
      and (
        select array_agg(a.attname::text order by a.attname)
        from generate_series(0, i.indnkeyatts - 1) as k(pos)
        join pg_attribute a
          on a.attrelid = i.indrelid
         and a.attnum = i.indkey[k.pos]
      ) = array['source', 'source_id', 'user_id']
  ) into v_has_unique;

  if v_has_unique then
    return;
  end if;

  if exists (
    select 1
    from public.xp_ledger
    group by user_id, source, source_id
    having count(*) > 1
  ) then
    raise exception 'Cannot add the xp_ledger unique constraint: duplicate (user_id, source, source_id) rows exist. Resolve them explicitly; this migration will not rewrite ledger history.';
  end if;

  alter table public.xp_ledger
    add constraint xp_ledger_user_id_source_source_id_key unique (user_id, source, source_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Step placement: steps belong to subquests only.
-- ---------------------------------------------------------------------------
create or replace function public.assert_step_on_subquest()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not exists (
    select 1 from public.quests q
    where q.id = new.quest_id and q.kind = 'subquest'
  ) then
    raise exception 'Steps can only be attached to subquests';
  end if;
  return new;
end;
$$;
revoke all on function public.assert_step_on_subquest() from public, anon, authenticated;

drop trigger if exists quest_steps_require_subquest on public.quest_steps;
create trigger quest_steps_require_subquest
  before insert or update of quest_id on public.quest_steps
  for each row execute procedure public.assert_step_on_subquest();

-- ---------------------------------------------------------------------------
-- Step positions: serialize writes per quest and resolve position collisions
-- by appending to the end of the list.
-- ---------------------------------------------------------------------------
create or replace function public.lock_quest_for_step_write()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from public.quests where id = new.quest_id for update;
  if exists (
    select 1 from public.quest_steps
    where quest_id = new.quest_id and position = new.position and id is distinct from new.id
  ) then
    new.position := coalesce((select max(position) from public.quest_steps where quest_id = new.quest_id), -1) + 1;
  end if;
  return new;
end;
$$;
revoke all on function public.lock_quest_for_step_write() from public, anon, authenticated;

drop trigger if exists quest_steps_lock_quest on public.quest_steps;
create trigger quest_steps_lock_quest
  before insert on public.quest_steps
  for each row execute procedure public.lock_quest_for_step_write();

-- ---------------------------------------------------------------------------
-- Quest identity is immutable: id, owner, kind and parent can never change.
-- ---------------------------------------------------------------------------
create or replace function public.assert_quest_identity_immutable()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.id is distinct from old.id
    or new.user_id is distinct from old.user_id
    or new.kind is distinct from old.kind
    or new.parent_quest_id is distinct from old.parent_quest_id then
    raise exception 'Quest ownership and kind cannot be changed';
  end if;
  return new;
end;
$$;
revoke all on function public.assert_quest_identity_immutable() from public, anon, authenticated;

drop trigger if exists quests_identity_immutable on public.quests;
create trigger quests_identity_immutable
  before update on public.quests
  for each row execute procedure public.assert_quest_identity_immutable();

-- ---------------------------------------------------------------------------
-- The completion-control trigger is retired: completion happens through the
-- SECURITY DEFINER RPC and the caller-forgeable GUC bypass is gone. Guard
-- against any environment that still carries the trigger.
-- ---------------------------------------------------------------------------
drop trigger if exists quest_steps_completion_controlled on public.quest_steps;

-- ---------------------------------------------------------------------------
-- Centralized award lookup used by the delete/structure guards. SECURITY
-- DEFINER so the guards can use it regardless of the caller's EXECUTE rights;
-- revoked from clients.
-- ---------------------------------------------------------------------------
create or replace function public.quest_has_completion_xp(p_quest_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.xp_ledger
    where source = 'quest_completion' and source_id = p_quest_id
  ) or exists (
    select 1
    from public.quests child
    join public.xp_ledger x on x.source = 'quest_completion' and x.source_id = child.id
    where child.parent_quest_id = p_quest_id
  );
$$;
revoke all on function public.quest_has_completion_xp(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Awarded quests cannot be deleted, including a parent whose subquest has
-- awarded XP. Runs as SECURITY DEFINER through a trigger, so no client needs
-- EXECUTE on it.
-- ---------------------------------------------------------------------------
create or replace function public.assert_awarded_quests_not_deleted()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if public.quest_has_completion_xp(old.id) then
    raise exception 'Cannot delete a quest that has awarded completion XP';
  end if;
  return old;
end;
$$;
revoke all on function public.assert_awarded_quests_not_deleted() from public, anon, authenticated;

drop trigger if exists quests_prevent_rewarded_delete on public.quests;
drop trigger if exists quests_block_awarded_delete on public.quests;
create trigger quests_block_awarded_delete
  before delete on public.quests
  for each row execute procedure public.assert_awarded_quests_not_deleted();

-- ---------------------------------------------------------------------------
-- Structure freezing after rewards: no new subquest under an awarded parent,
-- no new step on an awarded quest.
-- ---------------------------------------------------------------------------
create or replace function public.assert_awarded_quest_structure_frozen()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_table_name = 'quests' then
    if new.kind = 'subquest' and public.quest_has_completion_xp(new.parent_quest_id) then
      raise exception 'Cannot add a subquest to a quest that has awarded completion XP';
    end if;
  elsif tg_table_name = 'quest_steps' then
    if public.quest_has_completion_xp(new.quest_id) then
      raise exception 'Cannot add a step to a quest that has awarded completion XP';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.assert_awarded_quest_structure_frozen() from public, anon, authenticated;

drop trigger if exists quest_steps_prevent_insert_after_reward on public.quest_steps;
drop trigger if exists quests_freeze_after_award on public.quests;
drop trigger if exists quest_steps_freeze_after_award on public.quest_steps;
create trigger quests_freeze_after_award
  before insert on public.quests
  for each row execute procedure public.assert_awarded_quest_structure_frozen();
create trigger quest_steps_freeze_after_award
  before insert on public.quest_steps
  for each row execute procedure public.assert_awarded_quest_structure_frozen();

-- ---------------------------------------------------------------------------
-- Removing a step can complete a quest: recompute the award so XP is never
-- silently stranded (and stays exactly-once through the ledger constraint).
-- ---------------------------------------------------------------------------
create or replace function public.maybe_award_after_incomplete_step_removed()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_user_id uuid;
  v_parent uuid;
begin
  select user_id, parent_quest_id into v_user_id, v_parent
  from public.quests where id = old.quest_id;
  if v_user_id is null then return old; end if;
  perform public.award_completed_quest_xp(old.quest_id, v_user_id);
  if v_parent is not null then
    perform public.award_completed_quest_xp(v_parent, v_user_id);
  end if;
  return old;
end;
$$;
revoke all on function public.maybe_award_after_incomplete_step_removed() from public, anon, authenticated;

drop trigger if exists quest_steps_award_after_delete on public.quest_steps;
create trigger quest_steps_award_after_delete
  after delete on public.quest_steps
  for each row execute procedure public.maybe_award_after_incomplete_step_removed();

-- ---------------------------------------------------------------------------
-- The XP ledger is append-only history.
-- ---------------------------------------------------------------------------
create or replace function public.assert_xp_ledger_immutable()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'XP ledger rows cannot be updated or deleted';
end;
$$;
revoke all on function public.assert_xp_ledger_immutable() from public, anon, authenticated;

drop trigger if exists xp_ledger_immutable on public.xp_ledger;
create trigger xp_ledger_immutable
  before update or delete on public.xp_ledger
  for each row execute procedure public.assert_xp_ledger_immutable();

-- ---------------------------------------------------------------------------
-- RLS: operation-specific policies. Every name a prior pass may have used is
-- dropped first so this works on the partial pre-phase-2 state and on the
-- fully migrated chain alike.
-- ---------------------------------------------------------------------------
drop policy if exists "profiles are private" on public.profiles;
drop policy if exists "profiles select own" on public.profiles;
drop policy if exists "profiles update own" on public.profiles;
drop policy if exists "quests are private" on public.quests;
drop policy if exists "quests select own" on public.quests;
drop policy if exists "quests insert own" on public.quests;
drop policy if exists "quests update own" on public.quests;
drop policy if exists "quests delete own" on public.quests;
drop policy if exists "steps are readable on owned quests" on public.quest_steps;
drop policy if exists "steps can be created on owned quests" on public.quest_steps;
drop policy if exists "steps select owned" on public.quest_steps;
drop policy if exists "steps insert incomplete owned" on public.quest_steps;
drop policy if exists "steps update incomplete owned" on public.quest_steps;
drop policy if exists "steps delete incomplete owned" on public.quest_steps;
drop policy if exists "steps follow owned quests" on public.quest_steps;
drop policy if exists "xp ledger is private" on public.xp_ledger;

create policy "profiles select own" on public.profiles
  for select to authenticated
  using ((select auth.uid()) = id);
create policy "profiles update own" on public.profiles
  for update to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);
create policy "quests select own" on public.quests
  for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "quests insert own" on public.quests
  for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy "quests update own" on public.quests
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
-- Ownership only. Awarded quests are refused by the
-- quests_block_awarded_delete trigger; calling quest_has_completion_xp() here
-- would break every own-quest delete, because RLS expressions run with the
-- caller's privileges and EXECUTE on that helper is revoked from clients.
create policy "quests delete own" on public.quests
  for delete to authenticated
  using ((select auth.uid()) = user_id);
create policy "steps select owned" on public.quest_steps
  for select to authenticated
  using (exists (select 1 from public.quests q where q.id = quest_id and q.user_id = (select auth.uid())));
create policy "steps insert incomplete owned" on public.quest_steps
  for insert to authenticated
  with check (
    completed_at is null and evidence_type is null and evidence_value is null
    and exists (select 1 from public.quests q where q.id = quest_id and q.user_id = (select auth.uid()) and q.kind = 'subquest')
  );
create policy "xp ledger is private" on public.xp_ledger
  for select to authenticated
  using ((select auth.uid()) = user_id);

-- ---------------------------------------------------------------------------
-- Privileges: column-level least privilege and an append-only ledger. Default
-- privileges are deliberately left untouched by this migration.
-- ---------------------------------------------------------------------------
revoke insert, update, delete on public.xp_ledger from public, anon, authenticated;
grant select on public.xp_ledger to authenticated;
revoke update, delete on public.quest_steps from public, anon, authenticated;
grant select, insert on public.quest_steps to authenticated;
revoke update on public.quests from authenticated;
grant update (title, due_date) on public.quests to authenticated;
grant select, insert, delete on public.quests to authenticated;
revoke references, trigger, truncate on table public.profiles, public.quests, public.quest_steps, public.xp_ledger from anon, authenticated;
revoke references, trigger, truncate on table public.quest_progress from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Award: serialize on the quest row so concurrent completions cannot both
-- observe an incomplete sibling and skip the award. The unique ledger
-- constraint keeps the outcome exactly-once.
-- ---------------------------------------------------------------------------
create or replace function public.award_completed_quest_xp(p_quest_id uuid, p_user_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_kind public.quest_kind;
  v_parent_id uuid;
  v_amount integer;
  v_inserted integer;
begin
  select kind, parent_quest_id into v_kind, v_parent_id
  from public.quests where id = p_quest_id and user_id = p_user_id
  for update;
  if not found then return false; end if;

  if v_kind = 'subquest' then
    if not exists (select 1 from public.quest_steps where quest_id = p_quest_id)
      or exists (select 1 from public.quest_steps where quest_id = p_quest_id and completed_at is null) then
      return false;
    end if;
    v_amount := 250;
  else
    if not exists (select 1 from public.quests where parent_quest_id = p_quest_id)
      or exists (
        select 1 from public.quests child
        where child.parent_quest_id = p_quest_id
          and (
            not exists (select 1 from public.quest_steps where quest_id = child.id)
            or exists (select 1 from public.quest_steps where quest_id = child.id and completed_at is null)
          )
      ) then
      return false;
    end if;
    v_amount := 1000;
  end if;

  insert into public.xp_ledger (user_id, source, source_id, amount, note)
  values (p_user_id, 'quest_completion', p_quest_id, v_amount, 'Awarded from computed quest completion')
  on conflict (user_id, source, source_id) do nothing;
  get diagnostics v_inserted = row_count;
  return v_inserted > 0;
end;
$$;
revoke all on function public.award_completed_quest_xp(uuid, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Step completion RPC: validates evidence, locks parent -> quest -> step, and
-- recomputes awards. There is no completion-control GUC: this SECURITY DEFINER
-- RPC is the only completion path for clients.
-- ---------------------------------------------------------------------------
create or replace function public.complete_quest_step(
  p_step_id uuid, p_evidence_type public.evidence_type, p_evidence_value text
)
returns table (step_id uuid, completed_at timestamp with time zone, xp_awarded boolean)
language plpgsql security definer set search_path = '' as $$
declare
  v_user_id uuid := auth.uid();
  v_quest_id uuid;
  v_parent_quest_id uuid;
  v_completed_at timestamptz;
  v_xp_awarded boolean := false;
  v_evidence text := trim(both from coalesce(p_evidence_value, ''));
begin
  if v_user_id is null then raise exception 'Authentication is required'; end if;
  if char_length(v_evidence) < 1 or char_length(v_evidence) > 4000 then
    raise exception 'Completion requires evidence between 1 and 4,000 characters';
  end if;

  select s.quest_id, q.parent_quest_id, s.completed_at
    into v_quest_id, v_parent_quest_id, v_completed_at
  from public.quest_steps s
  join public.quests q on q.id = s.quest_id
    where s.id = p_step_id and q.user_id = v_user_id;
  if not found then raise exception 'Quest step not found'; end if;

  -- Lock ancestors first so sibling completions serialize instead of both
  -- missing the award check (or deadlocking).
  if v_parent_quest_id is not null then
    perform 1 from public.quests where id = v_parent_quest_id for update;
  end if;
  perform 1 from public.quests where id = v_quest_id for update;
  select s.completed_at into v_completed_at from public.quest_steps s where s.id = p_step_id for update;

  if v_completed_at is null then
    update public.quest_steps
      set completed_at = now(), evidence_type = p_evidence_type, evidence_value = v_evidence
      where id = p_step_id;
    select s.completed_at into v_completed_at from public.quest_steps s where s.id = p_step_id;
  end if;

  v_xp_awarded := public.award_completed_quest_xp(v_quest_id, v_user_id);
  if v_parent_quest_id is not null then
    v_xp_awarded := public.award_completed_quest_xp(v_parent_quest_id, v_user_id) or v_xp_awarded;
  end if;
  return query select p_step_id, v_completed_at, v_xp_awarded;
end;
$$;
revoke all on function public.complete_quest_step(uuid, public.evidence_type, text) from public, anon;
grant execute on function public.complete_quest_step(uuid, public.evidence_type, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Canonical progress view, restated to keep security_invoker = true.
-- ---------------------------------------------------------------------------
create or replace view public.quest_progress with (security_invoker = true) as
with step_counts as (
  select q.id as quest_id,
    count(s.id)::integer as total_steps,
    count(s.id) filter (where s.completed_at is not null)::integer as completed_steps
  from public.quests q
  left join public.quest_steps s on s.quest_id = q.id
  group by q.id
), computed as (
  select q.id, q.user_id, q.parent_quest_id, q.title, q.kind, q.due_date, q.created_at, q.updated_at,
    case when q.kind = 'subquest' then
      case when sc.total_steps = 0 then 0 else round((sc.completed_steps::numeric / sc.total_steps) * 100)::integer end
    else coalesce((
      select round(avg(case when child_steps.total_steps = 0 then 0
        else (child_steps.completed_steps::numeric / child_steps.total_steps) * 100 end))::integer
      from public.quests child
      join step_counts child_steps on child_steps.quest_id = child.id
      where child.parent_quest_id = q.id
    ), 0) end as progress_percent
  from public.quests q
  join step_counts sc on sc.quest_id = q.id
)
select *, case when progress_percent = 0 then 'not_started' when progress_percent = 100 then 'done' else 'in_progress' end::text as status
from computed;
grant select on public.quest_progress to authenticated;
