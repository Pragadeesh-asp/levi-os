# LEVI OS — Remote Supabase Deployment Runbook

**Status: REVISED 2026-10-19 (review corrections applied) — NOT EXECUTED and not approved for
execution (see §13).**
Prepared 2026-10-18 from the Phase-1 local verification results, the Phase-1 remote audit, and the
repository at `HEAD 47edb79`; revised 2026-10-19 after the safety review. Nothing in this document
has been run against the remote project, and no remote connection was made while preparing it.

**Target project:** `ecmetptkxmrpduqhmsxo` (never written to by the local work).
**Deliverables applied by this runbook:** 7 of the 11 local migration files — the reconciliation
migration plus the six later files (see §2). The four phase-1/phase-2 files are deliberately **not**
applied (§2.3).

---

## 0. Hard rules for the operator

1. **Never** run `supabase db push`, `supabase db pull`, `supabase db reset`, or
   `supabase migration repair`, and **never** insert/update/delete rows in
   `supabase_migrations.schema_migrations`. (Rationale: §3.)
2. **Never** apply migration files `202609110001_initial_core.sql`,
   `20260911055031_quest_engine.sql`, `20260911140000_phase2_hardening.sql`, or
   `20260912120000_phase2_reconciliation.sql`. (Rationale: §2.3.)
3. One file per execution. The reconciliation migration and every later file run inside a single
   transaction; the enum file runs alone (§7).
4. Never paste database credentials, connection strings, or dumps into this repository, chat, or
   any tracked file. Use the dashboard's connection dialog on the owner's machine.
5. On any stop condition (§10): stop, capture the exact message/result, change nothing else, and
   bring it back to the owner. Never improvise DDL on production.
6. The agent that prepared this runbook must not execute any part of it; every execution step is
   owner-run.

---

## 1. Basis: verified facts vs. assumptions

### 1.1 Verified facts — local (Phase-1, re-confirmable from the repo)

| Fact | Evidence |
| --- | --- |
| The full 11-file chain applies cleanly to an empty PostgreSQL 17 database | `npm run db:test` → **11 migrations, 217 assertions** (160 + 57) |
| The reconciliation migration is re-runnable | 217 assertions still green after a second apply in a disposable container; object counts stable |
| INCLUDE-index handling was exercised end to end | equivalent `UNIQUE … INCLUDE` index swap + re-apply: guard skips constraint creation, 217 assertions green |
| Unit / static checks | `npm test` 96/96; `lint`, `typecheck`, `build` all pass |
| File contents frozen for this runbook | SHA-256 of the 7 files recorded in §2.2 |
| Repo state | `HEAD 47edb79`; nothing staged/committed; expected working-tree state: `M README.md`, `?? src/proxy.ts`, `?? src/proxy.test.ts`, `?? supabase/migrations/20260913120000_quest_core_reconciliation.sql`, `?? supabase/tests/11_quest_core_reconciliation.sql` |
| The enum migration is a single statement | `alter type public.xp_source add value if not exists 'achievement';` with its own explanatory header |
| Later files do not recreate the reconciliation's trigger/policy names, and do no apply-time DML on `quests`/`quest_steps` | Code inspection (grep of `create trigger`, `create policy`, DML) |
| `core_loop_engine` is the only later file that changes an existing table | adds nullable `xp_ledger.reversal_of`, replaces the `amount` CHECK (negative adjustments allowed), both additive; no existing row is rewritten |

### 1.2 Verified facts — remote (Phase-1 audit; a point-in-time observation)

| Fact | Recorded value |
| --- | --- |
| Migration history | **4 rows** in `supabase_migrations.schema_migrations` |
| Function bodies | v1-generation bodies, with `search_path = ''` |
| ACLs | anon: none; authenticated: EXECUTE on `complete_quest_step` only; service_role: all |
| `xp_source` enum | does **not** contain `achievement` |
| `quests` grants | UPDATE only on `(title, due_date)` |
| `quest_steps` grants | no UPDATE grant |
| Stale objects | triggers/policies from an earlier phase-2 pass are present |
| CLI | `db push` is unusable: the local chain's first file uses a 12-digit version (`202609110001`) that does not match CLI history expectations |

### 1.3 Assumptions (each is falsifiable, and each has a guard or stop condition)

| # | Assumption | If false |
| --- | --- | --- |
| A1 | The remote schema still matches the Phase-1 audit (no drift since the audit date). | Contradicting evidence at any gate → stop (§10, S3). |
| A2 | The remote's existing quest-core function signatures accept the reconciliation's `create or replace` definitions. | Apply error inside the transaction → automatic rollback → stop (S1). |
| A3 | The remote's base objects (tables, enums, columns) are compatible with the reconciliation's DDL. | Apply error → rollback → stop (S1). |
| A4 | No remote `quest_steps` rows violate the 1..4,000-character evidence rule for completed steps. | The `quest_steps_check` add aborts the transaction → rollback → stop (S1/S4). |
| A5 | The remote `xp_ledger` either already has an equivalent unique key on `(user_id, source, source_id)` or has no duplicates. | The migration's explicit duplicate exception aborts → rollback → stop (S1/S4). |
| A6 | The operator has a DDL-capable session (SQL editor as `postgres`, or the direct/session connection string of §5.1 — not the transaction pooler) and can take/restore a dump. | Preflight gate fails → do not start (S6). |
| A7 | The currently deployed app is compatible with the reconciled schema (same RPC signatures; all other changes additive). | Smoke tests fail in an unexplained way → stop (S8); app deploy is a separate owner decision. |
| A8 | Supabase daily backups / PITR availability is plan-dependent and unknown until the owner confirms it (§5.2). | Preflight P5 fails → do not start; without PITR there is no whole-project rollback path (§5.2). |
| A9 | The remote retains the phase-2-era default-privilege hardening (the excluded `20260912120000_phase2_reconciliation.sql` documents it as already established — it only "preserves" it), so newly created tables and functions do not inherit stock broad grants for `anon`. | The §9.1 items 7–8 `anon` checks fail. Rows remain protected by RLS either way (every new table has RLS with authenticated-only policies), but the audited "anon none" posture is not fully restored — stop and let the owner decide remediation; **do not change remote ACLs during this deployment**. |

**Inference, flagged:** the audit facts (absence of `achievement`, phase-2-era grants, no evidence of the
later modules) indicate the remote is **post-phase-2 and pre-core-loop**, i.e. files 5–11 (the
seven-file batch) were never applied. This is consistent with, but not proof of, that state; §10/S3
guards it.

---

## 2. The deployment batch — exact order and why

### 2.1 Order

Apply exactly these 7 files, in this order, from the repository root
(`supabase/migrations/`):

| # | File | Mode | Why it is here |
| --- | --- | --- | --- |
| 1 | `20260913120000_quest_core_reconciliation.sql` | single transaction | Forward-only reconciliation of the audited remote state. Normalizes the 10 quest-core functions to `search_path = ''`, rebuilds policies/triggers, retires the stale GUC trigger, and (re)establishes the `xp_ledger` exactly-once unique key that every later reward depends on. |
| 2 | `20260918093000_xp_source_achievement.sql` | **own execution; must commit** | Adds the `achievement` enum value used at runtime by achievement awards. Must be committed before file 3 (and before any client use). |
| 3 | `20260918100000_core_loop_engine.sql` | single transaction | Missions / habits / achievements engine. Needs the committed enum value and the reconciled ledger; creates `daily_missions`, `habits`, `habit_logs`, `achievements`, `player_achievements`, canonical stats, and the adjustment validator. |
| 4 | `20260918110000_plan_edit_grants.sql` | single transaction | Column-level plan-edit grants and policy for `daily_missions` (created in #3) and tightened `profiles` grants. |
| 5 | `20260918120000_day_review_backfill.sql` | single transaction | Redefines `log_habit` (from #3) to reject future dates; adds `day_summary`. |
| 6 | `20260918130000_focus_sessions_and_ordering.sql` | single transaction | Adds `focus_sessions` and `reorder_missions`; revokes the `position` grant added by #4. References `daily_missions` (#3). |
| 7 | `20261018090000_action_history_and_analytics.sql` | single transaction | **Must be last.** Its `analytics_range` reads `focus_sessions` (#6), `player_achievements` / `daily_missions` / `habits` (#3), and it re-expresses `day_summary` (#5) as the single-day case of the range. |

This is exactly the local chain's timestamp order restricted to the files that the audited remote
still needs. The local harness has only ever applied them in this order.

### 2.2 Frozen file identities (verify before starting — §4, gate P3)

| File | SHA-256 |
| --- | --- |
| `20260913120000_quest_core_reconciliation.sql` | `8A2DE836C16B7FB95BCEB61EF7D5E56CE267893258484BEB7876CAF04909DB37` |
| `20260918093000_xp_source_achievement.sql` | `1A5295A6B7B5FCE57DBABB701ABA2E8C31EA86D14F6A9950D42D58F2866A5936` |
| `20260918100000_core_loop_engine.sql` | `58EE5AB213780CE666BD1A1B209D657B9A213A2D519AF702033EA4E1BD7B1283` |
| `20260918110000_plan_edit_grants.sql` | `6FFA84C268D177412C8BDDEB50AA18426ECFEA77DE66C7BC1C3267F5AAF6149A` |
| `20260918120000_day_review_backfill.sql` | `E2D5864F491A88DCA65104A591B2183AABB3168A463E7D50E9D0431ED85A092D` |
| `20260918130000_focus_sessions_and_ordering.sql` | `B30E94CF417D93628480F8223348E38C6F22886F73333DBE751D2182E87C2B34` |
| `20261018090000_action_history_and_analytics.sql` | `2F2C58A51C6970AE8F2EBD71EDCFCEA8F7AA39885BB74E99A5C215E403DCC59A` |

On Windows: `Get-FileHash -Algorithm SHA256 <file>`. On macOS/Linux: `shasum -a 256 <file>`.

### 2.3 Why files 1–4 are NOT applied

- The audit shows the remote already carries the phase-1/phase-2-era effects of those files
  (tables, initial engine, stale phase-2 objects).
- The reconciliation migration is the designed forward path from exactly that state; the local
  review verified it against an audited-state proxy (`initial_core + quest_engine + phase2_hardening`
  then the reconciliation file) as well as against the full chain.
- Files 3 and 4 contain the defects the reconciliation fixes (their function bodies use
  `search_path = public`; file 4's delete policy depends on a helper revoked from clients; file 3
  creates the retired completion-control trigger). Re-applying them — especially after the
  reconciliation — would reintroduce those defects.
- Nothing in the six later files (batch 2–7) depends on the excluded files beyond the state the reconciliation establishes.

Application code deployment is **out of scope** of this runbook; the database changes are additive
and preserve the app-facing RPC signatures, so the DB can be reconciled before any app deploy
(smoke tests in §9 confirm compatibility).

---

## 3. Handling the four remote migration-history rows

The remote has four history rows. This runbook **leaves them exactly as they are**.

**What is done:**

- Nothing. No INSERT, UPDATE, or DELETE against `supabase_migrations.schema_migrations`; no
  `migration repair`; no `db push`/`db pull`/`db reset`.
- The deployment is recorded instead in this runbook's execution log (§12): date, file SHA-256s,
  per-file outcomes, operator — and that log is required to be preserved durably after deployment
  (§12).

**Why this is the only honest option:**

1. `db push` is unusable for this project (verified: the local chain's first file uses a 12-digit
   version stamp that does not match CLI history expectations).
2. The four rows cannot be mapped one-to-one onto the local 11-file chain with the evidence in
   hand; any "repair" would be a guess.
3. A guessed repair would *falsely mark migrations as applied* — strictly worse than an
   unaligned history.
4. The migrations being applied are self-contained SQL; none of them requires a history row to
   apply correctly.

**Consequences the owner accepts explicitly:**

- The dashboard's migration list will keep showing the old four rows and will **not** reflect the
  reconciled schema.
- No document or status may claim the remote is "at migration X" or that history is aligned.
- Any future CLI-managed workflow (including history alignment) is a separate, deliberate project.
  This runbook does not design or recommend one, and it must not be improvised during deployment.
- Until then, future migrations continue through the same manual mechanism.

---

## 4. Preflight checklist (built only from available evidence)

No new remote SQL inventory is required or requested. Every item below is an attestation, a local
check, or a required action.

| # | Gate | Evidence / action | Fail → |
| --- | --- | --- | --- |
| P1 | Phase-1 evidence reviewed and accepted | §1.1 and §1.2 read; local numbers and remote audit facts acknowledged | Do not start |
| P2 | Stop conditions accepted | §10 read; operator agrees to stop on any of them | Do not start |
| P3 | File integrity | SHA-256 of the 7 files matches §2.2 | **STOP** |
| P4 | Repo state | `git rev-parse --short HEAD` = `47edb79`; working tree as in §1.1; no post-hash edits to the 7 files | **STOP and re-baseline** |
| P5 | Backup | Taken and verified per §5.1; PITR / platform-backup availability confirmed per §5.2 | Do not start |
| P6 | Access | A DDL-capable session is available (SQL editor as `postgres`, or the direct/session connection string — not the transaction pooler); the app's publishable key is not used for SQL | Do not start |
| P7 | Window | Low-traffic moment chosen; start time recorded; no concurrent deploys | Reschedule |
| P8 | Approval G1 | Owner explicitly approves starting (§11) | Do not start |

---

## 5. Backup and recovery

### 5.1 Backup (before G1 execution)

The operator runs Windows PowerShell. Use the project's **direct/session** connection string from
the dashboard (port 5432) for `pg_dump`, `pg_restore`, and `psql` — never the transaction-pooler
URL (port 6543): its transaction mode is not suitable for dumps, restores, or session-level
settings. The client tools must be **at least as new as the server's major version**
(`pg_dump --version`; an older client refuses to run against a newer server).

The seven migrations modify only the `public` schema, so the safety dump is scoped to
`--schema=public`. A public-schema dump is **not** a whole-project backup: it cannot restore
Supabase-managed schemas (`auth`, `storage`, extensions) — that remains the platform's job (§5.2).

```powershell
# 1. Refuse to run with an empty connection string (an empty value makes pg_dump fall back
#    to local/default connection parameters and can silently dump the wrong database)
if ([string]::IsNullOrWhiteSpace($env:DATABASE_URL)) { throw "DATABASE_URL is not set - aborting" }

# 2. Dump the public schema (custom format includes data; do not use --schema-only)
pg_dump $env:DATABASE_URL --format=custom --schema=public --file=levi-pre-reconcile-<YYYYMMDD>.dump

# 3. Verify the custom dump and explicitly reject it unless all three core tables are present
$toc = pg_restore --list levi-pre-reconcile-<YYYYMMDD>.dump
$missing = @()
foreach ($t in 'quests','quest_steps','xp_ledger') {
  $pattern = 'TABLE( DATA)? public[ .]' + [regex]::Escape($t) + '(\s|$)'
  if (-not ($toc | Select-String -Pattern $pattern -Quiet)) { $missing += $t }
}
if ($missing.Count -gt 0) { throw ("dump rejected; missing table entries: " + ($missing -join ', ')) }
"dump verified: TABLE entries for public.quests, public.quest_steps, public.xp_ledger"
```

- Git Bash / WSL is acceptable **only** with `export DATABASE_URL=...` set there to the same
  direct/session string; do not mix shells mid-procedure.
- Store the dump **outside the repository**; treat it as sensitive; never commit it. Keep the
  original file unmodified and verify it again with `pg_restore --list` before any restore.
- If the dump cannot be taken, or the check reports a missing table → **do not start** (S6).

### 5.2 Recovery semantics

| Situation | Recovery |
| --- | --- |
| Any file errors mid-apply (including the §6 `lock_timeout` precaution) | That file's transaction rolls back automatically; earlier files stay; the remote is untouched by the failed file. Fix the cause (or stop), then re-apply **only the failed file**. |
| A file succeeded, then a problem is discovered later | Prefer a forward fix: a new, reviewed migration (same manual mechanism). Do not hand-edit production. |
| Public-schema rollback required | Restoring the `--schema=public` dump is a **deliberate recovery operation, not a turnkey live-project rollback**: it is not certified by this runbook and remains unverified until rehearsed on a throwaway project. The shape to rehearse (never first against the live project): `pg_restore --clean --if-exists --no-owner -d $env:DATABASE_URL levi-pre-reconcile-<date>.dump`. `--clean` drops and recreates the dumped objects, reverting *all* public-schema changes made after the dump — including rows written to the new tables afterward — and foreign keys in the dump assume the managed `auth` schema still exists. Take a fresh dump first if needed; the restore loses post-backup data. |
| Whole-project recovery | A public-schema dump cannot restore the whole Supabase project. Before G1 the owner confirms whether the project has PITR / dashboard backups (plan-dependent; §4 P5): if present, that platform capability is the only whole-project recovery path; if absent, accept explicitly that no whole-project rollback exists. |

Do **not** re-run a file that already succeeded. Several statements are idempotent by design, but
that is not assumed anywhere.

**Enum note:** PostgreSQL has **no `DROP VALUE`** operation for enum values. Once the `achievement`
value is committed (§7), it cannot be removed by ordinary DDL; reversing it requires restoring from
a backup (above) or building a deliberate type-replacement migration as its own, separately
reviewed project. Do not attempt either as part of this deployment.

---

## 6. Executing the reconciliation migration atomically (file 1 of 7)

**Mechanics — one of two equivalent forms.** The `lock_timeout` line is an execution-side
precaution only; it does **not** modify the migration file.

- psql (PowerShell):
  `psql $env:DATABASE_URL -v ON_ERROR_STOP=1 -1 -c "set local lock_timeout = '5s';" -f supabase\migrations\20260913120000_quest_core_reconciliation.sql`
  (`-1` wraps everything in one transaction; psql processes repeated `-c`/`-f` options in the order
  given. Abort if `$env:DATABASE_URL` is empty — use the same direct/session string as §5.1.)
- SQL editor: paste `begin;` then `set local lock_timeout = '5s';` then the **entire** file, then
  `commit;` — all in a single execution.

**Why atomic:** the file makes ~20 coordinated DDL changes (constraint replacement, 10 function
replacements, policy/trigger rebuilds, grants). A partial apply would leave mixed generations of
quest-core objects. In a transaction, any error leaves the database exactly at the audited state.
The file itself contains no transaction-control statements, so both forms above are valid.

**Why the `lock_timeout`:** the migration's `ALTER TABLE … ADD CONSTRAINT` steps take
`ACCESS EXCLUSIVE` locks on `quests`, `quest_steps`, and `xp_ledger`. Under concurrent app traffic
the migration would otherwise wait — and block the app behind it — for as long as other sessions
hold those locks; the timeout converts that into a fast **clean rollback**: nothing was applied and
the remote is untouched.

**Rules:**

- Do not split the file; do not run other statements in the same execution/session batch.
- On error: the transaction rolled back. **STOP**, capture the exact error, and apply §10 — with
  one documented exception: a `lock_timeout` failure may be retried at a quieter moment (nothing
  was applied); if it recurs, stop.
- After success: run the post-R acceptance checks (§9.1, items 1–5) and require approval **G2**
  before continuing (§11). The migration is verified re-runnable, but a successful run needs no
  repeat.

---

## 7. The achievement enum, separately (file 2 of 7)

Apply the file's single statement as **its own execution**, immediately before file 3:

```sql
alter type public.xp_source add value if not exists 'achievement';
```

- Do not combine it with any other file or statement. PostgreSQL allows `ALTER TYPE … ADD VALUE`
  inside a transaction, but the new value cannot be **used** until that transaction commits — the
  core-loop engine awards achievement XP, so the value must be committed first (this is the
  reason the file exists on its own; see its header).
- The `if not exists` makes a repeat harmless, but do not plan to repeat.

**Verify committed before continuing (owner-run):**

```sql
select enum_range(null::public.xp_source);
```

Expected: the list includes `achievement`. If it does not, **STOP** (S2).

---

## 8. The dependent migrations (files 3–7 of 7)

Apply each file as a single transaction, in the order of §2.1, with the dependencies already stated
there. Summary of what each waits for:

| File | Waits for |
| --- | --- |
| `20260918100000_core_loop_engine.sql` | committed `achievement` value (§7); reconciled ledger + functions (§6) |
| `20260918110000_plan_edit_grants.sql` | `daily_missions` and `profiles` (`core_loop_engine`) |
| `20260918120000_day_review_backfill.sql` | `log_habit`, `habits`, `habit_logs` (`core_loop_engine`) |
| `20260918130000_focus_sessions_and_ordering.sql` | `daily_missions` (`core_loop_engine`); the `position` grant it revokes was added by `plan_edit_grants` |
| `20261018090000_action_history_and_analytics.sql` | everything above; `focus_sessions` and `day_summary` included |

After the last file, ask PostgREST to pick up the new schema (owner-run):
`notify pgrst, 'reload schema';` — Supabase normally reloads on DDL via its event triggers; this is
belt-and-braces. **Then** run the post-batch checks (§9.1) and the application smoke tests (§9.2),
so the smoke tests run last and hit the reloaded API.

---

## 9. Post-deployment verification

### 9.1 Database acceptance checks (owner-run; read-only)

**After the reconciliation (before G2):**

1. Policies on the quest core — expected exactly:

   | Table | Policies |
   | --- | --- |
   | `profiles` | `profiles select own`, `profiles update own` |
   | `quests` | `quests select own`, `quests insert own`, `quests update own`, `quests delete own` |
   | `quest_steps` | `steps select owned`, `steps insert incomplete owned` |
   | `xp_ledger` | `xp ledger is private` |

   ```sql
   select tablename, policyname from pg_policies
   where schemaname = 'public'
     and tablename in ('profiles','quests','quest_steps','xp_ledger')
   order by tablename, policyname;
   ```

   Any extra or missing row → **STOP** (S2; a surviving policy from an audited drop-list gap is
   exactly the drift this check is for).

2. Triggers — the reconciliation's eight must exist and the retired names must be gone:

   ```sql
   select tgrelid::regclass::text as relation, tgname
   from pg_trigger
   where not tgisinternal
     and tgrelid in ('public.quests'::regclass, 'public.quest_steps'::regclass, 'public.xp_ledger'::regclass)
     and tgname in ('quests_identity_immutable','quests_block_awarded_delete','quests_freeze_after_award',
                    'quest_steps_require_subquest','quest_steps_lock_quest','quest_steps_freeze_after_award',
                    'quest_steps_award_after_delete','xp_ledger_immutable')
   order by 1, 2;
   ```

   Expected: 8 rows. Must be absent (expect zero rows):

   ```sql
   select tgname from pg_trigger
   where not tgisinternal and tgrelid in ('public.quests'::regclass, 'public.quest_steps'::regclass)
     and tgname in ('quest_steps_completion_controlled','quests_prevent_rewarded_delete',
                    'quest_steps_prevent_insert_after_reward');
   ```

3. Delete policy must not call the revoked helper:

   ```sql
   select qual from pg_policies
   where schemaname='public' and tablename='quests' and policyname='quests delete own';
   ```

   Expected: ownership check only (`auth.uid() = user_id`), no `quest_has_completion_xp`.

4. Ledger uniqueness and view setting:

   ```sql
   select indexrelid::regclass::text as unique_index from pg_index
   where indrelid='public.xp_ledger'::regclass and indisunique order by 1;
   select reloptions from pg_class where oid='public.quest_progress'::regclass;
   ```

   Expected: `xp_ledger_pkey` and `xp_ledger_user_id_source_source_id_key`; reloptions
   `{security_invoker=true}`. If the named constraint is absent, inspect the unique indexes
   directly:

   ```sql
   select i.indexrelid::regclass::text as index, pg_get_indexdef(i.indexrelid) as definition
   from pg_index i
   where i.indrelid = 'public.xp_ledger'::regclass
     and i.indisunique
   order by 1;
   ```

   Accept only an equivalent unique index whose **key columns** are exactly `user_id`, `source`,
   `source_id` (any order). In the definition text, the key list is the parenthesized list after
   `USING btree`; columns after `INCLUDE (...)` are not key columns and are ignored — this mirrors
   the guard the migration itself uses (first `indnkeyatts` = 3 key attributes, compared as a set,
   no `WHERE` predicate, no expression). Anything else → **STOP** (S2).

5. Function hygiene — every quest-core function must keep `search_path=''`:

   ```sql
   select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('complete_quest_step','award_completed_quest_xp','assert_step_on_subquest',
                       'lock_quest_for_step_write','assert_quest_identity_immutable','quest_has_completion_xp',
                       'assert_awarded_quests_not_deleted','assert_awarded_quest_structure_frozen',
                       'maybe_award_after_incomplete_step_removed','assert_xp_ledger_immutable')
     and (p.proconfig is null or not p.proconfig @> array['search_path=""']);
   ```

   Expected: 0 rows.

   Then prove the post-R ACL on the one quest-core RPC the deployed v1 app calls — `authenticated`
   must be able to execute it and `anon` must not:

   ```sql
   select p.proname,
          has_function_privilege('authenticated', p.oid, 'execute') as authenticated_can_execute,
          has_function_privilege('anon', p.oid, 'execute') as anon_can_execute
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'complete_quest_step';
   ```

   Expected: one row; `authenticated_can_execute = true`, `anon_can_execute = false`.
   Anything else → **STOP** (S2).

**After the full batch:**

6. Enum and ledger internals:

   ```sql
   select enum_range(null::public.xp_source);
   select conname, pg_get_constraintdef(oid) from pg_constraint
   where conrelid='public.xp_ledger'::regclass order by conname;
   select tgname from pg_trigger where tgrelid='public.xp_ledger'::regclass and not tgisinternal order by 1;
   ```

   Expected: `achievement` present; the `amount` check allows negative adjustments
   (`amount <> 0 AND abs(amount) <= 10000`) and there is **no leftover stricter amount check**;
   triggers are `xp_ledger_immutable` and `xp_ledger_validate_adjustment`. A stale stricter check
   surfaces in the smoke test "reopen a mission removes XP" — treat that failure as a stop (S8).

7. New modules and RPC grants:

   ```sql
   select p.proname,
          has_function_privilege('authenticated', p.oid, 'execute') as authenticated_can_execute,
          has_function_privilege('anon', p.oid, 'execute') as anon_can_execute
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('set_mission_status','log_habit','reorder_missions','sync_achievements',
                       'start_focus_session','end_focus_session','day_summary')
   order by 1;
   ```

   Expected: one row per function; `authenticated_can_execute = true` and `anon_can_execute =
   false` for each. (The REST schema was reloaded in §8, before the smoke tests.)

8. ACL spot-check for the newly created tables — `anon` must hold no privileges; this also
   documents assumption A9 (default-privilege hardening inherited from outside this batch):

   ```sql
   select c.relname,
          has_table_privilege('anon', c.oid, 'select')   as anon_select,
          has_table_privilege('anon', c.oid, 'insert')   as anon_insert,
          has_table_privilege('anon', c.oid, 'update')   as anon_update,
          has_table_privilege('anon', c.oid, 'delete')   as anon_delete,
          has_table_privilege('anon', c.oid, 'truncate') as anon_truncate
   from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname in ('daily_missions','habits','habit_logs','achievements',
                       'player_achievements','focus_sessions','action_log')
   order by 1;
   ```

   Expected: seven rows, **all five columns `false`** for every row (matches the local chain,
   where the default-privilege hardening precedes table creation; `truncate` is checked because
   RLS does not protect it). If any value is `true`: rows are still protected by RLS (every new
   table has RLS with authenticated-only policies), but the audited "anon none" posture is not
   fully restored — **STOP** (S2), record it, and leave remediation to the owner. **Do not change
   remote ACLs during this deployment.**

### 9.2 Application smoke tests (owner-run, on the deployed app)

**Authentication**
- Magic-link sign-in succeeds and lands on `/dashboard`; sign out works (`/auth/signout` is
  POST-only and redirects to `/login`).
- A brand-new account gets a profile automatically (visible in `/settings`) with level 1, 0 XP.

**Quest CRUD**
- Create a main quest, a subquest under it, and a step; rename a quest (allowed); delete an
  unawarded quest (works, row disappears after refresh).
- Complete the quest flow below, then try to delete the awarded quest → refused with the
  "awarded completion XP" guard message, and the quest remains.

**Step completion**
- Completing with blank or >4,000-character evidence is refused; exactly 1..4,000 characters is
  accepted; the step shows as completed with its evidence.
- Completing a step on a main quest is refused (steps belong to subquests only).

**XP awards**
- Completing the only step of a subquest awards `+250` exactly once; re-completing the step adds
  nothing further.
- When every subquest of a main quest is complete, the main quest awards `+1000` once.
- `/dashboard` lifetime XP equals the sum of the ledger entries just created.
- Daily-mission loop: create a mission, complete it (`+50`), reopen (XP removed, `−50` adjustment),
  complete again (`+50`, never `+100`). Habit loop: log (+20), undo (−20), log again (+20).
- Achievement awards, if surfaced by the UI, unlock once (e.g. `first_blood` after the first
  completed mission) and never re-award.

**RLS isolation**
- With a second account: it sees **none** of the first account's quests, steps, XP, missions,
  habits, focus sessions, activity history, or analytics. `/quests`, `/xp`, and the quest detail
  pages show zero rows, not an error.
- A crafted cross-user operation (e.g. reordering the first account's missions by id) is rejected
  and changes nothing.
- Direct client writes to `xp_ledger` (insert/update/delete via the REST API with the anon key)
  fail with `permission denied`; the ledger is append-only.

**`quest_progress` view**
- It returns rows only for the signed-in owner (second account: 0 rows), and the quest list values
  (`progress_percent`, `status`) match the individual quest screens.
- The view keeps `security_invoker=true` (checked in §9.1, item 4) and remains readable through
  the API after the schema reload.

**Record results.** Anything not executed stays unverified; never mark a smoke test "passed" from
inspection.

---

## 10. Stop conditions — if the remote differs from the audited schema

On any item below: **stop immediately, capture the exact error/result, do not continue, and do not
improvise a fix.** The owner decides the follow-up; any deviation-handling step is a new decision
requiring its own review (and, if schema-affecting, its own runbook).

| # | Condition | Example signals |
| --- | --- | --- |
| S1 | Any error from the reconciliation transaction | `cannot change return type of existing function`; `relation … does not exist`; `column … does not exist`; enum/type mismatch; `must be owner of table`; the explicit duplicate-ledger exception; a `check_violation` from `quest_steps_check`. The transaction rolls back automatically. A §6 `lock_timeout` failure is the one documented retry case (nothing was applied); everything else stops. |
| S2 | Acceptance checks deviate — post-reconciliation checks (policies, triggers, view setting, function `search_path`, ledger uniqueness, the post-R ACL check) **and the post-batch checks §9.1 items 6–8** (enum/ledger internals, RPC grants, new-table ACLs) | Extra/missing policies or triggers; retired trigger still present; `search_path` not `''`; `complete_quest_step` not executable by `authenticated` or still executable by `anon`; `anon` holding privileges on new tables. |
| S3 | Pre-existing drift from the audited state | Any of files 1–7 already recorded as applied; the remote already has `daily_missions` / `habits` / `focus_sessions` / `action_log` (the premise is then wrong); history row count differs from the audit; `achievement` already present before §7 (confirm the cause before proceeding — the apply itself is safe due to `if not exists`, the *premise* is what needs review). |
| S4 | Dirty data blocks the guarded steps | Evidence-cap violation on existing completed steps; duplicate `(user_id, source, source_id)` ledger rows without an equivalent unique index. Cleanup is a separate owner decision — never edit the migration to pass. |
| S5 | History/CLI interference | Anyone ran `db push`, `db pull`, `db reset`, or `migration repair` since the audit, or wrote to `schema_migrations`. Re-establish the actual state before any further apply. |
| S6 | Backup missing or unverified | No dump, empty dump, or failed listing. |
| S7 | File hash mismatch for any of the 7 files | Someone changed a migration after this runbook recorded its hash; re-baseline and re-review first. |
| S8 | Smoke tests fail in a way not explained by app-deploy timing | Especially: XP doubled, reopen/re-complete not balanced, cross-user reads succeed, `quest_progress` leaks rows. |
| S9 | Anything ambiguous | Prefer stopping over guessing; production DDL is never improvised. |

---

## 11. Owner approval gates

| Gate | When | What is approved |
| --- | --- | --- |
| G1 | Before any execution — passes only when **all of P1–P8** are green (§4; P8 is this approval itself) | Start the deployment: apply file 1 and hold at G2. |
| G2 | After the reconciliation — passes only when §9.1 items 1–5 match exactly | Continue to the enum file and files 3–7. |
| G3 | After the enum check — passes only when §7 shows `achievement` committed | Continue with `core_loop_engine` and the remaining four files. |
| — | Always | Use of production credentials (owner only); backup step; any handling of a stop condition; any deviation from this runbook; full restore; app-code deployment (separate decision). |

The agent that prepared this runbook executes nothing — not even a read-only query.

---

## 12. Execution log (fill in during deployment)

| Step | File | SHA-256 verified | Mode | Started (UTC) | Result | Notes / exact errors |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `20260913120000_quest_core_reconciliation.sql` | ☐ | transaction | | | |
| 2 | `20260918093000_xp_source_achievement.sql` | ☐ | alone | | | |
| 3 | `20260918100000_core_loop_engine.sql` | ☐ | transaction | | | |
| 4 | `20260918110000_plan_edit_grants.sql` | ☐ | transaction | | | |
| 5 | `20260918120000_day_review_backfill.sql` | ☐ | transaction | | | |
| 6 | `20260918130000_focus_sessions_and_ordering.sql` | ☐ | transaction | | | |
| 7 | `20261018090000_action_history_and_analytics.sql` | ☐ | transaction | | | |
| — | §9.1 acceptance checks | | | | | |
| — | §9.2 smoke tests | | | | | |
| — | **Durable record** — commit this runbook or archive it with the backup | — | commit / archive | | | required step |

Operator: __________ Project: `ecmetptkxmrpduqhmsxo` Backup file: __________

**Record durability (required step).** Once the deployment is finished, preserve this completed
runbook and execution log durably — either in a deliberate Git commit of this file or in an archive
stored alongside the backup (outside the repository). This record is the **authoritative list of the
migrations actually applied and their outcomes**; the remote migration history does not reflect the
deployment (§3), so this is the only applied-set record.

---

## 13. Status

- **Runbook status: ready for G1 review.** This document is complete and balanced against its
  sources (verified local evidence, the Phase-1 remote audit, and the frozen file set); it requires
  no further investigation and no new remote inventory. Readiness for review is not approval to
  execute.
- **Execution is not approved by this document.** It may start only after G1 passes — owner
  approval with **all of P1–P8** green (§4), including the verified backup (§5.1) and the owner's
  PITR confirmation (§5.2). Any stop condition (§10) flips the remainder to stopped until the owner
  resolves it; nothing in this runbook authorizes improvised production DDL.
- Nothing has been executed and no remote connection has been made.

### Notes on evidence limits (read before trusting anything above)

- The local test evidence proves the *files*, not the remote state; the remote facts are a
  point-in-time audit and are assumptions A1–A9 until exercised.
- The history remains unaligned by design (§3); the execution log — not the migration history —
  is the record of what was applied.
- No procedure for aligning the migration history is included here, because none can be derived
  honestly from the available evidence. Inventing one would falsely mark migrations as applied.
