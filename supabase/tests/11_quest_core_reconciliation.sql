-- ===========================================================================
-- Quest-core reconciliation assertions (migration 20260913120000).
--
-- Self-contained: defines its own helper and fixtures, so it never relies on
-- objects or variables from 10_engine_assertions.sql (which drops its helper
-- before this file runs). Executes as postgres and switches into
-- `authenticated` to exercise RLS and function ACLs.
--
-- The concurrency section opens a second session with dblink so a completion
-- can genuinely contend for the quest row lock, which is the mechanism that
-- stops concurrent completions from silently missing an eligible award.
-- ===========================================================================
\set ON_ERROR_STOP on

create or replace function public.test_assert_recon(p_ok boolean, p_label text)
returns void language plpgsql as $$
begin
  if p_ok is distinct from true then
    raise exception 'ASSERTION FAILED: %', p_label;
  end if;
  raise notice 'ok - %', p_label;
end;
$$;
grant execute on function public.test_assert_recon(boolean, text) to authenticated;

create extension if not exists dblink;

-- The second session used by the concurrency section is opened here, while
-- the session runs as postgres: dblink refuses non-superuser connections that
-- are not password-authenticated. The named connection is reused later from
-- the `authenticated` role.
select dblink_connect('recon_concurrent', 'dbname=postgres');
select dblink_exec('recon_concurrent', 'set request.jwt.claim.sub = ''55555555-5555-5555-5555-555555555555''');
select dblink_exec('recon_concurrent', 'set statement_timeout = ''1000ms''');

-- Fixtures: two users, distinct from the ids used by 10_engine_assertions.sql.
insert into auth.users (id, email) values
  ('55555555-5555-5555-5555-555555555555', 'recon-a@example.test'),
  ('66666666-6666-6666-6666-666666666666', 'recon-b@example.test')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Catalogue invariants of the reconciliation
-- ---------------------------------------------------------------------------
select public.test_assert_recon(
  not exists (
    select 1 from pg_trigger
    where tgname = 'quest_steps_completion_controlled'
      and tgrelid = 'public.quest_steps'::regclass
  ),
  'the retired completion-control trigger is not present'
);
select public.test_assert_recon(
  exists (
    select 1 from pg_trigger
    where tgname = 'quests_block_awarded_delete'
      and tgrelid = 'public.quests'::regclass
      and tgenabled = 'O'
  ),
  'the parent-aware delete guard is armed on public.quests'
);
select public.test_assert_recon(
  (select coalesce(reloptions, '{}') from pg_class where oid = 'public.quest_progress'::regclass)
    @> array['security_invoker=true'],
  'quest_progress keeps security_invoker=true'
);
select public.test_assert_recon(
  exists (
    select 1 from pg_index i
    where i.indrelid = 'public.xp_ledger'::regclass
      and i.indisunique and i.indisvalid and i.indisready
      and i.indpred is null and i.indexprs is null
      and i.indnkeyatts = 3
      and (
        select array_agg(a.attname::text order by a.attname)
        from generate_series(0, i.indnkeyatts - 1) as k(pos)
        join pg_attribute a on a.attrelid = i.indrelid and a.attnum = i.indkey[k.pos]
      ) = array['source', 'source_id', 'user_id']
  ),
  'xp_ledger enforces unique (user_id, source, source_id) for idempotent awards'
);

-- The guard that decides whether the constraint must be created compares key
-- columns only; these scratch tables pin down both edges of that predicate
-- (mirrored from the migration): INCLUDE columns are ignored, a key subset is
-- rejected.
create temp table recon_guard_include (
  user_id uuid, source text, source_id uuid, note text
);
create unique index recon_guard_include_key
  on recon_guard_include (user_id, source, source_id) include (note);
create temp table recon_guard_subset (
  user_id uuid, source text, source_id uuid
);
create unique index recon_guard_subset_key
  on recon_guard_subset (user_id, source) include (source_id);

select public.test_assert_recon(
  exists (
    select 1 from pg_index i
    where i.indrelid = 'pg_temp.recon_guard_include'::regclass
      and i.indisunique and i.indisvalid and i.indisready
      and i.indpred is null and i.indexprs is null
      and i.indnkeyatts = 3
      and (
        select array_agg(a.attname::text order by a.attname)
        from generate_series(0, i.indnkeyatts - 1) as k(pos)
        join pg_attribute a on a.attrelid = i.indrelid and a.attnum = i.indkey[k.pos]
      ) = array['source', 'source_id', 'user_id']
  ),
  'the unique-index guard accepts a key match that carries INCLUDE columns'
);
select public.test_assert_recon(
  not exists (
    select 1 from pg_index i
    where i.indrelid = 'pg_temp.recon_guard_subset'::regclass
      and i.indisunique and i.indisvalid and i.indisready
      and i.indpred is null and i.indexprs is null
      and i.indnkeyatts = 3
      and (
        select array_agg(a.attname::text order by a.attname)
        from generate_series(0, i.indnkeyatts - 1) as k(pos)
        join pg_attribute a on a.attrelid = i.indrelid and a.attnum = i.indkey[k.pos]
      ) = array['source', 'source_id', 'user_id']
  ),
  'the unique-index guard rejects an index whose key columns are a subset'
);
drop table recon_guard_include, recon_guard_subset;
select public.test_assert_recon(
  (select qual from pg_policies
   where schemaname = 'public' and tablename = 'quests' and policyname = 'quests delete own')
    not like '%quest_has_completion_xp%',
  'the quests delete policy does not depend on the revoked helper'
);
select public.test_assert_recon(
  has_function_privilege('authenticated', 'public.complete_quest_step(uuid, public.evidence_type, text)', 'execute'),
  'authenticated may execute complete_quest_step'
);
select public.test_assert_recon(
  not has_function_privilege('authenticated', 'public.award_completed_quest_xp(uuid, uuid)', 'execute'),
  'authenticated may not execute the award helper'
);
select public.test_assert_recon(
  not has_function_privilege('authenticated', 'public.quest_has_completion_xp(uuid)', 'execute'),
  'authenticated may not execute the completion-XP helper'
);
select public.test_assert_recon(
  not has_function_privilege('anon', 'public.complete_quest_step(uuid, public.evidence_type, text)', 'execute'),
  'anon may not execute complete_quest_step'
);
select public.test_assert_recon(
  (select proconfig from pg_proc
   where oid = 'public.complete_quest_step(uuid, public.evidence_type, text)'::regprocedure)
    @> array['search_path=""'],
  'complete_quest_step keeps an empty search_path'
);
select public.test_assert_recon(
  (select proconfig from pg_proc where oid = 'public.award_completed_quest_xp(uuid, uuid)'::regprocedure)
    @> array['search_path=""'],
  'award_completed_quest_xp keeps an empty search_path'
);
select public.test_assert_recon(
  (select proconfig from pg_proc where oid = 'public.assert_step_on_subquest()'::regprocedure)
    @> array['search_path=""'],
  'assert_step_on_subquest keeps an empty search_path'
);
select public.test_assert_recon(
  (select proconfig from pg_proc where oid = 'public.lock_quest_for_step_write()'::regprocedure)
    @> array['search_path=""'],
  'lock_quest_for_step_write keeps an empty search_path'
);
select public.test_assert_recon(
  (select proconfig from pg_proc where oid = 'public.assert_quest_identity_immutable()'::regprocedure)
    @> array['search_path=""'],
  'assert_quest_identity_immutable keeps an empty search_path'
);
select public.test_assert_recon(
  (select proconfig from pg_proc where oid = 'public.quest_has_completion_xp(uuid)'::regprocedure)
    @> array['search_path=""'],
  'quest_has_completion_xp keeps an empty search_path'
);
select public.test_assert_recon(
  (select proconfig from pg_proc where oid = 'public.assert_awarded_quests_not_deleted()'::regprocedure)
    @> array['search_path=""'],
  'assert_awarded_quests_not_deleted keeps an empty search_path'
);
select public.test_assert_recon(
  (select proconfig from pg_proc where oid = 'public.assert_awarded_quest_structure_frozen()'::regprocedure)
    @> array['search_path=""'],
  'assert_awarded_quest_structure_frozen keeps an empty search_path'
);
select public.test_assert_recon(
  (select proconfig from pg_proc where oid = 'public.maybe_award_after_incomplete_step_removed()'::regprocedure)
    @> array['search_path=""'],
  'maybe_award_after_incomplete_step_removed keeps an empty search_path'
);
select public.test_assert_recon(
  (select proconfig from pg_proc where oid = 'public.assert_xp_ledger_immutable()'::regprocedure)
    @> array['search_path=""'],
  'assert_xp_ledger_immutable keeps an empty search_path'
);

set role authenticated;
set request.jwt.claim.sub = '55555555-5555-5555-5555-555555555555';

-- ---------------------------------------------------------------------------
-- Function ACLs, observed behaviourally
-- ---------------------------------------------------------------------------
do $$
declare
  v_err text;
begin
  begin
    perform public.award_completed_quest_xp(gen_random_uuid(), '55555555-5555-5555-5555-555555555555'::uuid);
    v_err := null;
  exception when others then
    if sqlerrm like 'ASSERTION FAILED%' then raise; end if;
    v_err := sqlerrm;
  end;
  if v_err is null then
    raise exception 'ASSERTION FAILED: authenticated could execute the award helper';
  end if;
  if v_err not like '%permission denied%' then
    raise exception 'ASSERTION FAILED: unexpected error from the award helper: %', v_err;
  end if;
  raise notice 'ok - the award helper stays revoked from authenticated at runtime';
end $$;

-- ---------------------------------------------------------------------------
-- Quest deletion: own unawarded quests are deletable; awarded quests are
-- refused by the guard trigger (not silently filtered by the policy)
-- ---------------------------------------------------------------------------
insert into public.quests (title, kind) values ('Recon deletable main', 'main')
  returning id as deletable_quest \gset
delete from public.quests where id = :'deletable_quest';
select public.test_assert_recon(
  (select count(*) from public.quests where id = :'deletable_quest') = 0,
  'an authenticated owner can delete an unawarded quest'
);

insert into public.quests (title, kind) values ('Recon awarded main', 'main')
  returning id as awarded_main \gset
insert into public.quests (title, kind, parent_quest_id)
  values ('Recon awarded subquest', 'subquest', :'awarded_main')
  returning id as awarded_sub \gset
insert into public.quest_steps (quest_id, title, position)
  values (:'awarded_sub', 'Only step', 0)
  returning id as awarded_step \gset
select public.complete_quest_step(:'awarded_step', 'note', 'Evidence that unlocks the award');
select public.test_assert_recon(
  (select count(*) from public.xp_ledger
   where source = 'quest_completion' and source_id = :'awarded_sub') = 1,
  'completing the only step awards the subquest exactly once'
);

do $$
declare
  v_err text;
begin
  begin
    delete from public.quests
    where id = (select id from public.quests where title = 'Recon awarded subquest');
    v_err := null;
  exception when others then
    if sqlerrm like 'ASSERTION FAILED%' then raise; end if;
    v_err := sqlerrm;
  end;
  if v_err is null then
    raise exception 'ASSERTION FAILED: deleting an awarded subquest succeeded';
  end if;
  if v_err not like '%awarded completion XP%' then
    raise exception 'ASSERTION FAILED: awarded-subquest delete refused for the wrong reason: %', v_err;
  end if;
  raise notice 'ok - deleting an awarded subquest is refused by the guard trigger';
end $$;

do $$
declare
  v_err text;
begin
  begin
    delete from public.quests
    where id = (select id from public.quests where title = 'Recon awarded main');
    v_err := null;
  exception when others then
    if sqlerrm like 'ASSERTION FAILED%' then raise; end if;
    v_err := sqlerrm;
  end;
  if v_err is null then
    raise exception 'ASSERTION FAILED: deleting an awarded main quest succeeded';
  end if;
  if v_err not like '%awarded completion XP%' then
    raise exception 'ASSERTION FAILED: awarded-main delete refused for the wrong reason: %', v_err;
  end if;
  raise notice 'ok - deleting an awarded main quest is refused as well';
end $$;

select public.test_assert_recon(
  (select count(*) from public.quests
   where title in ('Recon awarded main', 'Recon awarded subquest')) = 2,
  'both refused deletions left their quest rows in place'
);

-- ---------------------------------------------------------------------------
-- Evidence validation: blank and over-long evidence are refused, the 4,000
-- character boundary is accepted
-- ---------------------------------------------------------------------------
insert into public.quests (title, kind) values ('Recon evidence main', 'main')
  returning id as evidence_main \gset
insert into public.quests (title, kind, parent_quest_id)
  values ('Recon evidence subquest', 'subquest', :'evidence_main')
  returning id as evidence_sub \gset
insert into public.quest_steps (quest_id, title, position)
  values (:'evidence_sub', 'Empty evidence step', 0) returning id as empty_step \gset
insert into public.quest_steps (quest_id, title, position)
  values (:'evidence_sub', 'Long evidence step', 1) returning id as long_step \gset
insert into public.quest_steps (quest_id, title, position)
  values (:'evidence_sub', 'Boundary evidence step', 2) returning id as boundary_step \gset

do $$
declare
  v_case text;
  v_err text;
begin
  foreach v_case in array array['', '   '] loop
    begin
      perform public.complete_quest_step(
        (select id from public.quest_steps where title = 'Empty evidence step'),
        'note',
        v_case
      );
      raise exception 'ASSERTION FAILED: blank evidence was accepted';
    exception when others then
      if sqlerrm like 'ASSERTION FAILED%' then raise; end if;
      v_err := sqlerrm;
    end;
  end loop;
  if v_err not like '%between 1 and 4,000 characters%' then
    raise exception 'ASSERTION FAILED: blank evidence refused for the wrong reason: %', v_err;
  end if;
  raise notice 'ok - completion refuses blank evidence';
end $$;

do $$
declare
  v_err text;
begin
  begin
    perform public.complete_quest_step(
      (select id from public.quest_steps where title = 'Long evidence step'),
      'note',
      repeat('x', 4001)
    );
    v_err := null;
  exception when others then
    if sqlerrm like 'ASSERTION FAILED%' then raise; end if;
    v_err := sqlerrm;
  end;
  if v_err is null then
    raise exception 'ASSERTION FAILED: 4,001-character evidence was accepted';
  end if;
  if v_err not like '%between 1 and 4,000 characters%' then
    raise exception 'ASSERTION FAILED: over-long evidence refused for the wrong reason: %', v_err;
  end if;
  raise notice 'ok - completion refuses evidence beyond 4,000 characters';
end $$;

select public.complete_quest_step(:'boundary_step', 'note', repeat('y', 4000));
select public.test_assert_recon(
  (select completed_at from public.quest_steps where id = :'boundary_step') is not null,
  'exactly 4,000 characters of evidence are accepted'
);

-- ---------------------------------------------------------------------------
-- Step invariants: subquests only, serialized positions, no direct writes
-- ---------------------------------------------------------------------------
do $$
declare
  v_err text;
begin
  begin
    insert into public.quest_steps (quest_id, title, position)
    values ((select id from public.quests where title = 'Recon evidence main'), 'Illegal main-quest step', 0);
    v_err := null;
  exception when others then
    if sqlerrm like 'ASSERTION FAILED%' then raise; end if;
    v_err := sqlerrm;
  end;
  if v_err is null then
    raise exception 'ASSERTION FAILED: a step was accepted on a main quest';
  end if;
  raise notice 'ok - steps cannot be attached to a main quest';
end $$;

insert into public.quests (title, kind) values ('Recon ordering main', 'main')
  returning id as order_main \gset
insert into public.quests (title, kind, parent_quest_id)
  values ('Recon ordering subquest', 'subquest', :'order_main')
  returning id as order_sub \gset
insert into public.quest_steps (quest_id, title, position)
  values (:'order_sub', 'Slot zero', 0) returning id as slot_zero \gset
insert into public.quest_steps (quest_id, title, position)
  values (:'order_sub', 'Colliding zero', 0) returning id as slot_bumped \gset
select public.test_assert_recon(
  (select position from public.quest_steps where id = :'slot_zero') = 0
    and (select position from public.quest_steps where id = :'slot_bumped') = 1,
  'a colliding step position is serialized to the next free slot'
);
select public.test_assert_recon(
  (select count(distinct position) from public.quest_steps where quest_id = :'order_sub') = 2,
  'serialized step positions stay unique per quest'
);

update public.quests set title = 'Recon ordering subquest (renamed)' where id = :'order_sub';
select public.test_assert_recon(
  (select count(*) from public.quests
   where id = :'order_sub' and title = 'Recon ordering subquest (renamed)') = 1,
  'owners can still update quest title under the column-level grants'
);

do $$
declare
  v_err text;
begin
  begin
    update public.quest_steps set title = 'Direct update attempt'
    where id = (select id from public.quest_steps where title = 'Slot zero');
    v_err := null;
  exception when others then
    if sqlerrm like 'ASSERTION FAILED%' then raise; end if;
    v_err := sqlerrm;
  end;
  if v_err is null then
    raise exception 'ASSERTION FAILED: a client updated quest_steps directly';
  end if;
  if v_err not like '%permission denied%' then
    raise exception 'ASSERTION FAILED: unexpected error updating quest_steps: %', v_err;
  end if;
  raise notice 'ok - quest_steps cannot be updated directly by clients';
end $$;

do $$
declare
  v_err text;
begin
  begin
    delete from public.quest_steps
    where id = (select id from public.quest_steps where title = 'Slot zero');
    v_err := null;
  exception when others then
    if sqlerrm like 'ASSERTION FAILED%' then raise; end if;
    v_err := sqlerrm;
  end;
  if v_err is null then
    raise exception 'ASSERTION FAILED: a client deleted a quest step directly';
  end if;
  if v_err not like '%permission denied%' then
    raise exception 'ASSERTION FAILED: unexpected error deleting a quest step: %', v_err;
  end if;
  raise notice 'ok - quest_steps cannot be deleted directly by clients';
end $$;

do $$
declare
  v_err text;
begin
  begin
    update public.quests set user_id = '66666666-6666-6666-6666-666666666666'
    where id = (select id from public.quests where title = 'Recon evidence main');
    v_err := null;
  exception when others then
    if sqlerrm like 'ASSERTION FAILED%' then raise; end if;
    v_err := sqlerrm;
  end;
  if v_err is null then
    raise exception 'ASSERTION FAILED: a client changed quest ownership';
  end if;
  raise notice 'ok - column-level grants keep quest ownership immutable';
end $$;

-- ---------------------------------------------------------------------------
-- Step removal: a half-complete subquest is unawarded, clients cannot delete
-- steps, and a privileged cleanup that removes the last incomplete step must
-- recompute the award (the privileged delete itself runs later, as postgres)
-- ---------------------------------------------------------------------------
insert into public.quests (title, kind) values ('Recon recovery main', 'main')
  returning id as recovery_main \gset
insert into public.quests (title, kind, parent_quest_id)
  values ('Recon recovery subquest', 'subquest', :'recovery_main')
  returning id as recovery_sub \gset
insert into public.quest_steps (quest_id, title, position)
  values (:'recovery_sub', 'Recovery step one', 0) returning id as recovery_step1 \gset
insert into public.quest_steps (quest_id, title, position)
  values (:'recovery_sub', 'Recovery step two', 1) returning id as recovery_step2 \gset
select public.complete_quest_step(:'recovery_step1', 'note', 'First recovery step');
select public.test_assert_recon(
  (select count(*) from public.xp_ledger
   where source = 'quest_completion' and source_id = :'recovery_sub') = 0,
  'a subquest with an incomplete step is not awarded'
);

do $$
declare
  v_err text;
begin
  begin
    delete from public.quest_steps
    where id = (select id from public.quest_steps where title = 'Recovery step two');
    v_err := null;
  exception when others then
    if sqlerrm like 'ASSERTION FAILED%' then raise; end if;
    v_err := sqlerrm;
  end;
  if v_err is null then
    raise exception 'ASSERTION FAILED: a client deleted an incomplete step';
  end if;
  if v_err not like '%permission denied%' then
    raise exception 'ASSERTION FAILED: unexpected error deleting a step: %', v_err;
  end if;
  raise notice 'ok - clients cannot delete quest steps directly';
end $$;

-- ---------------------------------------------------------------------------
-- Concurrency: while one completion holds the quest lock, a sibling
-- completion in a second session must wait instead of racing past the award
-- check. The second session is dblink with a short statement timeout.
-- ---------------------------------------------------------------------------
insert into public.quests (title, kind) values ('Recon concurrency main', 'main')
  returning id as conc_main \gset
insert into public.quests (title, kind, parent_quest_id)
  values ('Recon concurrency sub-a', 'subquest', :'conc_main')
  returning id as conc_sub_a \gset
insert into public.quests (title, kind, parent_quest_id)
  values ('Recon concurrency sub-b', 'subquest', :'conc_main')
  returning id as conc_sub_b \gset
insert into public.quest_steps (quest_id, title, position)
  values (:'conc_sub_a', 'Concurrency step A', 0);
insert into public.quest_steps (quest_id, title, position)
  values (:'conc_sub_b', 'Concurrency step B', 0);

begin;
do $$
declare
  v_step_a uuid;
  v_step_b uuid;
  v_err text;
begin
  select id into v_step_a from public.quest_steps where title = 'Concurrency step A';
  select id into v_step_b from public.quest_steps where title = 'Concurrency step B';

  -- Completing step A locks the main quest row and holds the locks until the
  -- rollback below, exactly like an in-flight completion transaction.
  perform public.complete_quest_step(v_step_a, 'note', 'Evidence for step A');

  begin
    perform 1 from dblink(
      'recon_concurrent',
      format('select 1 from public.complete_quest_step(%L::uuid, %L, %L)', v_step_b, 'note', 'Evidence for step B')
    ) as probe(x integer);
    v_err := null;
  exception
    -- WHEN OTHERS deliberately does not catch QUERY_CANCELED, so the
    -- statement timeout from the probing session is caught explicitly.
    when query_canceled then
      v_err := sqlerrm;
    when others then
      if sqlerrm like 'ASSERTION FAILED%' then raise; end if;
      v_err := sqlerrm;
  end;

  if v_err is null then
    raise exception 'ASSERTION FAILED: a concurrent completion did not wait for the quest lock';
  end if;
  if v_err not like '%timeout%' then
    raise exception 'ASSERTION FAILED: unexpected concurrency error: %', v_err;
  end if;
  raise notice 'ok - a concurrent completion waits on the quest lock';

  perform public.test_assert_recon(
    (select completed_at from public.quest_steps where id = v_step_b) is null,
    'the blocked concurrent completion left the sibling step incomplete'
  );
end $$;
rollback;

select public.test_assert_recon(
  (select completed_at from public.quest_steps where title = 'Concurrency step A') is null,
  'the rolled-back concurrent attempt left no partial state'
);
do $$
begin
  perform dblink_disconnect('recon_concurrent');
exception when others then null;
end $$;

-- Both subquests now complete sequentially: every level is awarded once, and
-- replaying a completed step never duplicates XP.
select public.complete_quest_step(
  (select id from public.quest_steps where title = 'Concurrency step A'), 'note', 'Evidence for step A');
select public.complete_quest_step(
  (select id from public.quest_steps where title = 'Concurrency step B'), 'note', 'Evidence for step B');
select public.test_assert_recon(
  (select count(*) from public.xp_ledger
   where source = 'quest_completion'
     and source_id in (
       (select id from public.quests where title = 'Recon concurrency main'),
       (select id from public.quests where title = 'Recon concurrency sub-a'),
       (select id from public.quests where title = 'Recon concurrency sub-b')
     )) = 3,
  'serialized completion awards every quest level exactly once'
);
select public.complete_quest_step(
  (select id from public.quest_steps where title = 'Concurrency step A'), 'note', 'Evidence for step A again');
select public.test_assert_recon(
  (select count(*) from public.xp_ledger
   where source = 'quest_completion'
     and source_id = (select id from public.quests where title = 'Recon concurrency main')) = 1,
  're-completing an already completed step never duplicates XP'
);

-- ---------------------------------------------------------------------------
-- Cross-user isolation
-- ---------------------------------------------------------------------------
set request.jwt.claim.sub = '66666666-6666-6666-6666-666666666666';

select public.test_assert_recon(
  (select count(*) from public.quests where id = :'order_main') = 0,
  'RLS hides another user''s quest'
);
select public.test_assert_recon(
  (select count(*) from public.xp_ledger) = 0,
  'RLS hides another user''s XP ledger'
);
with removed as (
  delete from public.quests where id = :'order_main' returning 1 as deleted
)
select public.test_assert_recon(
  (select count(*) from removed) = 0,
  'a cross-user delete removes no rows'
);

-- ---------------------------------------------------------------------------
-- Postgres-side probes: table-level constraints, privileged cleanup awards,
-- and the legacy parent-aware delete guard
-- ---------------------------------------------------------------------------
reset role;

select public.test_assert_recon(
  (select count(*) from public.quests where id = :'order_main') = 1,
  'the cross-user delete attempt left the other user''s quest in place'
);

do $$
declare
  v_blocked boolean := false;
begin
  begin
    insert into public.quest_steps (quest_id, title, position, completed_at, evidence_type, evidence_value)
    values (
      (select id from public.quests where title = 'Recon evidence subquest'),
      'Constraint probe', 90, now(), 'note', repeat('z', 4001)
    );
  exception when check_violation then
    v_blocked := true;
  end;
  if not v_blocked then
    raise exception 'ASSERTION FAILED: the 4,000-character evidence cap is not enforced at the table level';
  end if;
  raise notice 'ok - the evidence cap is enforced by the table constraint too';
end $$;

delete from public.quest_steps where id = :'recovery_step2';
select public.test_assert_recon(
  (select count(*) from public.xp_ledger
   where source = 'quest_completion' and source_id = :'recovery_sub') = 1,
  'removing the last incomplete step awards the completed subquest'
);
select public.test_assert_recon(
  (select count(*) from public.xp_ledger
   where source = 'quest_completion' and source_id = :'recovery_main') = 1,
  'the parent quest is awarded once its subquest is complete'
);

-- Legacy state: a child with awarded XP but no parent ledger row (the state
-- the pre-locking award race could leave behind). The parent must still be
-- protected from deletion through the child branch of the helper.
insert into public.quests (id, user_id, title, kind) values
  ('77777777-7777-7777-7777-777777777777', '55555555-5555-5555-5555-555555555555', 'Recon legacy main', 'main');
insert into public.quests (id, user_id, title, kind, parent_quest_id) values
  ('88888888-8888-8888-8888-888888888888', '55555555-5555-5555-5555-555555555555', 'Recon legacy subquest', 'subquest',
   '77777777-7777-7777-7777-777777777777');
insert into public.xp_ledger (user_id, source, source_id, amount, note) values
  ('55555555-5555-5555-5555-555555555555', 'quest_completion', '88888888-8888-8888-8888-888888888888', 250,
   'Legacy child award fixture (no parent ledger row)');

-- The ledger is append-only history. Probes run as postgres on purpose: they
-- prove the immutability trigger itself refuses the write, not the (also
-- revoked) client table privileges. The row addressed here is the fixture
-- above, so the probes are guaranteed to touch a real row.
do $$
declare
  v_err text;
begin
  begin
    update public.xp_ledger
    set note = coalesce(note, '') || ' (tamper attempt)'
    where user_id = '55555555-5555-5555-5555-555555555555'
      and source = 'quest_completion'
      and source_id = '88888888-8888-8888-8888-888888888888';
    v_err := null;
  exception when others then
    if sqlerrm like 'ASSERTION FAILED%' then raise; end if;
    v_err := sqlerrm;
  end;
  if v_err is null then
    raise exception 'ASSERTION FAILED: an xp_ledger row was updated despite the immutability trigger';
  end if;
  if v_err not like '%cannot be updated or deleted%' then
    raise exception 'ASSERTION FAILED: ledger update blocked for the wrong reason: %', v_err;
  end if;
  raise notice 'ok - the immutability trigger refuses ledger updates, even for a privileged session';
end $$;

do $$
declare
  v_err text;
begin
  begin
    delete from public.xp_ledger
    where user_id = '55555555-5555-5555-5555-555555555555'
      and source = 'quest_completion'
      and source_id = '88888888-8888-8888-8888-888888888888';
    v_err := null;
  exception when others then
    if sqlerrm like 'ASSERTION FAILED%' then raise; end if;
    v_err := sqlerrm;
  end;
  if v_err is null then
    raise exception 'ASSERTION FAILED: an xp_ledger row was deleted despite the immutability trigger';
  end if;
  if v_err not like '%cannot be updated or deleted%' then
    raise exception 'ASSERTION FAILED: ledger delete blocked for the wrong reason: %', v_err;
  end if;
  raise notice 'ok - the immutability trigger refuses ledger deletes, even for a privileged session';
end $$;

select public.test_assert_recon(
  (select note from public.xp_ledger
   where user_id = '55555555-5555-5555-5555-555555555555'
     and source = 'quest_completion'
     and source_id = '88888888-8888-8888-8888-888888888888')
    = 'Legacy child award fixture (no parent ledger row)',
  'the refused tamper attempts left the ledger row untouched'
);

set role authenticated;
set request.jwt.claim.sub = '55555555-5555-5555-5555-555555555555';

do $$
declare
  v_err text;
begin
  begin
    delete from public.quests where id = '77777777-7777-7777-7777-777777777777';
    v_err := null;
  exception when others then
    if sqlerrm like 'ASSERTION FAILED%' then raise; end if;
    v_err := sqlerrm;
  end;
  if v_err is null then
    raise exception 'ASSERTION FAILED: a parent with an awarded subquest was deleted';
  end if;
  if v_err not like '%awarded completion XP%' then
    raise exception 'ASSERTION FAILED: parent delete refused for the wrong reason: %', v_err;
  end if;
  raise notice 'ok - a parent quest whose child has XP cannot be deleted either';
end $$;

do $$
declare
  v_err text;
begin
  begin
    insert into public.quest_steps (quest_id, title, position)
    values ((select id from public.quests where title = 'Recon recovery subquest'), 'Late step', 5);
    v_err := null;
  exception when others then
    if sqlerrm like 'ASSERTION FAILED%' then raise; end if;
    v_err := sqlerrm;
  end;
  if v_err is null then
    raise exception 'ASSERTION FAILED: an awarded quest accepted a new step';
  end if;
  if v_err not like '%awarded completion XP%' then
    raise exception 'ASSERTION FAILED: late step refused for the wrong reason: %', v_err;
  end if;
  raise notice 'ok - awarded quests refuse new steps';
end $$;

do $$
declare
  v_err text;
begin
  begin
    insert into public.quests (title, kind, parent_quest_id)
    values ('Late subquest', 'subquest', (select id from public.quests where title = 'Recon recovery main'));
    v_err := null;
  exception when others then
    if sqlerrm like 'ASSERTION FAILED%' then raise; end if;
    v_err := sqlerrm;
  end;
  if v_err is null then
    raise exception 'ASSERTION FAILED: an awarded quest accepted a new subquest';
  end if;
  if v_err not like '%awarded completion XP%' then
    raise exception 'ASSERTION FAILED: late subquest refused for the wrong reason: %', v_err;
  end if;
  raise notice 'ok - awarded quests refuse new subquests';
end $$;

reset role;
drop function public.test_assert_recon(boolean, text);
\echo '-------------------------------------------------------------------------'
\echo ' Quest-core reconciliation assertions complete'
\echo '-------------------------------------------------------------------------'
