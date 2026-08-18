# Merge UAT with Async Inspect Implementation Plan

> **For Claude:** Implement this plan directly in the current worktree; sub-agent delegation is not authorized for this task.

**Goal:** Merge the latest `origin/UAT` into `codex/fix-async-inspec`, preserve UAT's stage-attribution behavior, and ensure every configured harness inspect command executes asynchronously with bounded global concurrency.

**Architecture:** Resolve the three overlapping harness files by retaining Promise propagation from the async-inspect branch and integrating UAT's bounded stage cache, invalidation, and priming paths. Route every `inspectCommands` process launch through the existing async child-process runner and a shared FIFO semaphore so the Electron main process remains responsive and Python concurrency remains bounded.

**Tech Stack:** Git, Electron, TypeScript, Node.js child processes.

---

### Task 1: Merge UAT and preserve both feature sets

**Files:**
- Modify through merge: `src/main/harness-board/service.ts`
- Modify through merge: `src/main/ipc/agent.ts`
- Modify through merge: `src/main/ipc/harness-board.ts`
- Accept UAT additions and non-conflicting changes.

1. Merge `origin/UAT` without discarding either side wholesale.
2. Keep all run/project detail and stage-resolution service functions asynchronous.
3. Keep UAT stage attribution priming and invalidation behavior.
4. Update all callers to await Promise-returning service APIs.

### Task 2: Route all inspect commands through asynchronous execution

**Files:**
- Modify: `src/main/harness-board/service.ts`
- Modify callers identified by repository search.

1. Remove synchronous harness invocation from every `inspectCommands` path.
2. Convert remaining dynamic workflow, session context, create, skip, and related configured-command APIs to async where required.
3. Propagate Promise signatures through IPC and agent setup callers without changing result schemas.

### Task 3: Bound inspect process concurrency

**Files:**
- Modify: `src/main/harness-board/service.ts`

1. Add a small FIFO semaphore local to the harness service.
2. Use a global inspect-command limit of 2.
3. Acquire immediately before spawning and release in `finally` on success, failure, timeout, or spawn error.
4. Keep UAT's per-feature stage single-flight cache as the duplicate-request control for code-generation attribution.

### Task 4: Verify the merged result

**Files:**
- Lint only files changed by the merge resolution and async propagation.

1. Confirm no conflict markers or unmerged paths remain.
2. Search for synchronous child-process calls reachable from `inspectCommands` and verify none remain.
3. Run targeted ESLint without `--fix`.
4. Run `npm run typecheck:node` and `npm run typecheck:web` if renderer/preload changes require it.
5. Run existing stage-attribution, harness-runtime, hook, and affected Git-policy tests.
6. Do not run a production build and do not add or rewrite tests.
7. Complete the merge commit after verification.
