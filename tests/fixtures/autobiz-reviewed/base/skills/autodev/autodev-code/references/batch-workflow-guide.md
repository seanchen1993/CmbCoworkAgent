# Code Batch Workflow Guide

This guide covers the fixed Code batch workflow. Read it when a Code feature
has pending Batches. The workflow control plane is repository-owned at
`workflows/code-batched-execution.workflow.js`; do not generate, validate, or
replace it with model output.

## Start

Run the launcher in the mounted workspace of the platform Workflow tool. Keep
the artifact workspace as the `--workspace` value and pass the mounted path as
`--workflow-workspace`:

```bash
python -X utf8 "${pluginPath}/hooks/workflow_launcher.py" \
  --feature "${feature}" \
  --plugin-path "${pluginPath}" \
  --workspace "${artifactWorkspace}" \
  --workflow-workspace "$(pwd)" \
  --json
```

For one or more physical Git roots, start the returned fixed script path once
when all of these are true. Pass the complete launcher `workflowArgs` mapping
to that one Workflow. It creates a shared scheduler run and uses `parallel()`
to start one agent chain for each independently runnable Batch; each chain
provisions its own repository-native Worktree. The fixed Workflow performs
B-E2E and final verification after all delivery Batches are promoted. The
launcher keeps a Feature-scoped archival copy in
`artifactWorkspace/.cmbdevclaw/workflows/<feature>/`, then copies that fixed
script into `workflowWorkspace/.cmbdevclaw/workflows/<feature>/` for the
platform call. `workflowScriptPath` is the mounted-workspace copy and
`workflowArtifactScriptPath` is the archival copy; both match
`workflowScriptSha256`. `workflowScriptSource` identifies the immutable
source. `workflowArgs` is the complete argument object for the Workflow call;
do not reconstruct it.

- `useWorkflow=true`
- `canStartWorkflow=true`
- validation reason is `parallel_plan_valid` or `single_batch_workflow_valid`
- any number of physical roots: `executionMode=fixed` and
  `requiredAction=start_fixed_workflow`

The launcher reads the mandatory top-level `plan.json.codeWorkspaces` mapping
and returns the complete `codeWorkspaces` mapping, optional
`workflowHostGitRoot` metadata, and `executionIsolation=native_git_worktrees`.
`artifactWorkspace` is only the artifact/state directory and must never be
reused as a code workspace by guesswork. The plugin creates linked native
checkouts from each `codeWorkspaces` binding, so the host may be launched from
the artifact directory. A fixed Workflow can cover multiple Git roots (and
multiple logical refs may share a root). It uses one shared scheduler run and
starts parallel Batch agents inside the same Workflow. A multi-root mapping is
not a Plan error. A missing or invalid mapping is a Plan error: stop and
repair the Plan. There is no CLI workspace override or legacy mapping fallback.

There is no `task_runner.py code-session` command and no
`hooks/code_session.py`. Capture the baseline only with
`rollback_stage.py --capture-code-session`; then start the fixed Workflow via
the launcher. Any baseline workspace argument must be the absolute business
Git root, never a logical workspace name such as `RouYi`.

The Code Session baseline uses format v2: clean committed files are recorded
as Git blob references (`storage=git_blob`, `gitSha`) instead of copied content;
staged, unstaged, and untracked files still receive durable content objects so
rollback preserves pre-existing local changes. An active baseline from an
older format is not migrated and must be cleared before recapturing.

The Workflow tool invocation is fixed too:

Use the top-level Workflow tool with this native parameter object (not from a wrapper workflow):

```javascript
{
  scriptPath: launcher.workflowScriptPath,
  args: launcher.workflowArgs
}
```

The launcher must materialize the mounted-workspace launch copy before this
call. Do not use the plugin source, business repository path, or inline
content. Use
`resumeFromRunId` only while the platform Workflow itself is interrupted or
non-terminal. If the platform Workflow already returned a terminal result but
the scheduler run still has `retry_pending` or stage-recovery Batches, start a
fresh platform Workflow with the same launcher `scriptPath` and `args` (no
`resumeFromRunId`). `scheduler ensure` then reuses the durable scheduler run
and reads its current state instead of replaying a completed platform journal.

Before making this call, pass the platform Workflow tool's already-mounted
workspace to the launcher as `--workflow-workspace` (or launch the command
from that directory). `launcher.workflowWorkspaceRoot` must then equal that
absolute path, and `workflowScriptRelativePath` proves the returned script is
contained below it. If the platform mounts a different workspace root, stop
with `workflow_workspace_root_mismatch` and rerun the launcher with the
correct mounted path. Do not replace the returned script with the plugin
source, a business-repository path, or inline content.

The Workflow host workspace is not a Worktree source contract. The plugin
resolves every repository from the complete `codeWorkspaces` mapping and
provisions its own native Worktree for each Batch. The artifact workspace
remains independent and only stores Feature state.

## Execution Contract

### Frontend Route Gate

Route 解析不属于 Code Session 的全局前置步骤。Batch Agent 必须先执行
`code_task_context.py`，再以返回的 `taskContract.uiRequired` 判断当前 Task：
后端 Task 跳过 Route resolver、HTML 和 Route SKILL；前端 Task 才能在同一
Agent 内完成 Route 解析、清单、parser（如适用）和 `FRONTEND_ROUTE.json`
回检。这样同一批次中的后端 Task 不会被其他 Task 的 UI 产物阻塞。

The fixed script starts with scheduler `ensure` and then runs a merge-gated,
dynamic-slot DAG. `ensure` creates the first durable run or reuses an active
run only after validating every sealed native delivery. A `needs_resolution`
run or a missing sealed worktree remains fail-closed; do not create a new run
to bypass it.

The reuse validation also blocks a Batch marked `merged` without a non-empty
`mergeCommitSha`, a dirty source checkout, or a source HEAD that differs from
the run's recorded HEAD. In each case it returns the original `runId` with a
blocked result. A Batch is `merged` only when `parallel_merge_train.py` has
fast-forwarded the candidate Merge Train SHA whose Batch Review and UTest
evidence already passed, and written its
merge commit; no worker-facing command may
set this status.

The fixed Workflow passes `--allow-bootstrap` to `ensure`. When a source
repository has uncommitted business changes, the scheduler automatically creates
one `autodev: bootstrap <feature> baseline` commit before native worktrees
are provisioned. This is the only automatic source-branch commit before Batch
delivery merges; platform-owned `.cmbdevclaw/**` files are excluded from both
the dirty check and baseline commit. Direct CLI uses of `ensure` do not enable
bootstrap by default and return `parallel_code_workspace_bootstrap_required`
instead of modifying the repository.

The same controlled bootstrap policy applies to every repository binding in a
multi-root run. Platform runtime files are excluded and the scheduler records
one explicit baseline commit per physical Git root before Batch worktrees are
provisioned.

1. The scheduler selects pending Batches whose dependencies are all `merged`,
   whose write sets are safe with every active Batch lifecycle, and for which a
   `maxParallel` slot is free. Active includes running Review/UTest stages after
   a delivery has been sealed. The Workflow runs a fixed `maxParallel` worker
   pool: each worker executes one lifecycle, refreshes immediately on completion,
   and idle workers poll every five minutes while another lifecycle is active.
   A failure releases that worker to dispatch an unrelated Batch; dependents
   remain blocked until their dependency is merged.
2. The worker pool runs tasks concurrently with `parallel()` up to `maxParallel`.
   Every Batch independently runs code → Review → UTest/seal
   → Merge Train promotion. A fast Batch may therefore
   review, test, and merge while another Batch in the same frontier is still
   coding. Every Batch records its actual Worktree path and branch in the
   scheduler manifest. In conservative mode, same-repository write-set overlap
   is excluded before launch; optimistic mode records that risk for Merge Train
   handling. Each Merge Train candidate contains exactly one `--batch-id`; its
   `--wave` value is only a unique candidate-record sequence.
3. Each Batch acquires a lease, implements only its assigned TASKs, then
   invokes `worktree_manager.py seal --purpose review` to create a
   Review draft. The draft is
   released as `sealed` for the following read-only Review.
4. `parallelBatchPipeline.validationOwnership` assigns every test intent to
   its delivery Batch except `e2e_test`, which belongs to final B-E2E.  The
   delivery UTest agent generates and runs its own tests in the native
   Worktree.
5. Each Review draft first performs production-code-only `review`. A Review
   source bug returns to that Batch's implement repair and a new seal. The
   Review is then recorded as resolved. The resulting
   delivery performs UTest in the same Worktree and re-seals the test assets.
   Any final UTest failure is
   retained with its runner Evidence as a non-blocking issue and proceeds to
   later stages without restarting implementation, Review, or UTest. Only
   then is it `ready_to_candidate`.
   The shared Workflow builds a Merge Train candidate and fast-forwards it
   directly; no candidate test phase is run. A changed main SHA makes the candidate
   stale and requires rebuild rather than rebase.
6. After Batch lifecycles settle, the script calls scheduler `resume` to
   calculate newly unlocked work. A dependent Batch never starts from an
   unmerged upstream result, but unrelated Batches do not wait for a failed peer.
7. The merge hook writes `mergeCommitSha` and only then marks the Batch TASKs
   `done`. A Review-and-UTest-processed delivery remains `implemented` /
   `sealed` until this source-branch integration succeeds; Code itself has no
   independent compile result.
   If promotion succeeds but the Plan writer fails, the run is retained in
   `needs_resolution` until its Plan state is recovered.
8. Once all Batches are `merged`, B-E2E runs in a temporary validation
   Worktree. `parallel_evidence_aggregate.py` then validates existing
   content-bound evidence only; it never runs a duplicate compile/test command.

Independent Batches run in parallel, including independent Batches in the same
repository. A dependency chain advances only after its upstream merge commit,
while unrelated ready work fills available slots immediately.

An execution-stage failure is recorded as `retry_pending`, not terminal
`failed`. Scheduler `resume` reclaims its lease and reschedules the Batch in
its existing Worktree while unrelated Batches continue. After the bounded
automatic retry budget is exhausted, that Batch becomes `blocked`; only its
dependent branch stops, and the Workflow returns `partial_blocked` without
starting B-E2E. After diagnostics are addressed, an operator may explicitly
mark that Batch `retry_pending` and resume the same run; it is never stranded
as an irrecoverable `failed` record.

## Batch Agent Boundaries

Within its plugin-provisioned native Git Worktree, a Batch agent must:

- acquire and later release the `runId + batchId` lease;
- capture its actual path and branch from `pwd`, `git rev-parse --show-toplevel`
  and `git branch --show-current`; it must not create/delete a worktree or fall
  back to the artifact workspace or source checkout;
- pass `--workspace`, `--parallel-run-id`, and `--lease-token` to every
  `task_runner.py` command;
- acquire the Batch lease with the scheduler's `timeoutPerBatch` as
  `--ttl-seconds <timeoutPerBatch> --lease-guard`. Guarded leases have a
  four-hour minimum even when an older Workflow snapshot passes 3600 seconds.
  Agent command sandboxes do not preserve child processes, so the plugin
  renews the durable lease at each lease-bearing
  `task_runner.py` and `worktree_manager.py` command boundary instead of
  requiring a background daemon. Agents must not start a heartbeat through
  shell backgrounding, `run_in_background`, `&`, `nohup`, or `Start-Process`.
  Before seal, run
  `check --owner-token <token> --require-lease-guard`;
- pass the plugin-provisioned Worktree as `--code-workspace`;
- complete all assigned TASKs, draft-seal with `--purpose review`, and wait for
  the Workflow's Review stage;
- after Review, let the fixed Workflow proceed directly to UTest; it creates
  and seals test assets before the Batch becomes ready to merge.

The Batch agent must not merge, rebase, resolve conflicts, delete Worktrees, or
modify a shared main checkout. It receives no platform isolation option.
The shared Workflow owner is the only actor that invokes the merge hook.
All workflow paths and the feature ID come only from launcher `workflowArgs`;
literal `undefined` or non-absolute paths are rejected before any Batch agent
is created. A Batch agent must never compensate by creating a branch or a
second workflow.

## Recovery And Failure

The manifest at `.parallel-runs/<runId>/manifest.json` is the only parallel-run
state.

- The fixed Workflow always uses `parallel_batch_scheduler.py ensure` at
  startup. It reuses an active, valid run rather than creating a second one.
  Use `parallel_batch_scheduler.py resume` only for an explicitly guided
  recovery after inspecting the retained run.
- Use `batch_lease_manager.py reclaim` for an expired lease and
  `parallel_batch_lifecycle.py monitor` to inspect a run.
- On an old unsealed Batch retry, verify the existing worktree against the
  exact Batch binding, branch, and frozen repository HEAD. If its dirty
  implementation passes, continue in place without provisioning. If it no
  longer passes, change the recovery to `retry_dispatch` so the Batch enters
  normal scheduling and provision archives and replaces its old checkout.
  A fresh Batch without a retry marker keeps the original provision behavior.
- When an idle plugin-owned Batch worktree has a HEAD different from the run's
  current repository HEAD, provision saves its old commit under a recovery Git
  ref and archives Git-visible uncommitted files under the run's
  `recovery-worktrees/` directory. It then recreates the checkout from the
  current repository HEAD. An explicit `retry_dispatch` also archives and
  replaces a dirty same-HEAD checkout that could not be resumed in place.
  The Batch manifest and event report
  `recoveryArchivePath`; active leases and recorded delivery commits prevent
  this replacement.
- The fixed Workflow defaults to four hours per Batch; UTest keeps its separate
  15-minute stage budget. The scheduler measures a repair attempt from its
  current lease acquisition, not from the Batch's first implementation.
  Do not rely on the lease CLI's 15-minute default for an unguarded Batch.
  A lease naturally expires if the agent cannot reach another lease-bearing plugin
  command before its TTL; every failure path must still release the lease with
  its prescribed final status.
- A candidate conflict, failed Batch stage, plan digest change, or failed B-E2E
  blocks the run. Do not use `ours`, `theirs`, `git merge -s ours`,
  `--no-verify`, or direct edits in the shared checkout to bypass it.
- After every successful merge, the fixed Workflow calls
  `parallel_batch_lifecycle.py cleanup-merged` before releasing downstream
  Batches. It removes only plugin-owned deliveries whose manifest status is
  `merged`, including an orphaned lease, native worktree, and temporary branch.
  A cleanup failure is retried at the start of the next Workflow. `failed`,
  `blocked`, and `needs_resolution` deliveries stay
  intact for diagnosis and recovery. Explicitly rolled-back terminal runs use
  `parallel_batch_lifecycle.py cleanup` to remove all remaining resources.
- Platform-owned `.cmbdevclaw/workflows/**` journal, state, and toolstream
  files are excluded from source-dirt checks. Do not use `git checkout -- .`
  or `git clean` to remove them: those commands can destroy user work or the
  Workflow journal needed for recovery.
- `parallel_merge_train.py` is the integration owner for this workflow. Once it
  has promoted the Batch-UTest-gated candidate and written `mergeCommitSha`, the fixed Workflow cleans that delivered native
  worktree and temporary branch before the scheduler may start a dependent
  Batch. Do not merge a delivery a second time or delete any unresolved
  worktree manually.
- Never delete `.parallel-runs/<runId>`, copy files out of an orphaned
  worktree, or manually merge a Batch branch. Those operations bypass delivery
  evidence and leave the run unrecoverable.
