# Inspect Async Implementation Plan

> **For Claude:** Implement this plan directly in the current session; sub-agent delegation is not authorized for this task.

**Goal:** Move project/run inspect execution off the Electron main-process event loop without changing inspect frequency, caching, watcher behavior, or UI APIs.

**Architecture:** Reuse the existing `runHarnessInvocationAsync` child-process runner and propagate `Promise` return types through the harness service, IPC handlers, per-turn stage attribution, and status reporter. Preserve sequential project-group inspection and all existing error handling so the only behavior change is that the main process remains responsive while Python runs.

**Tech Stack:** Electron, TypeScript, Node.js child processes.

---

### Task 1: Async harness service inspect paths

**Files:**
- Modify: `src/main/harness-board/service.ts`

1. Convert `runInspectAdapter` and `runInspectAdapterBatch` to async functions.
2. Replace their synchronous runner calls with `runHarnessInvocationAsync` using `HARNESS_ADAPTER_TIMEOUT_MS`.
3. Convert `resolveHarnessFeatureCurrentStage`, `getHarnessProjectDetail`, `getHarnessProjectDetails`, and `getHarnessRunDetail` to async functions.
4. Preserve sequential project-group processing and existing parsing/error behavior.

### Task 2: Propagate async signatures to callers

**Files:**
- Modify: `src/main/ipc/harness-board.ts`
- Modify: `src/main/ipc/agent.ts`
- Modify: `src/main/services/harness-status-reporter.ts`

1. Await detail service calls in harness IPC handlers.
2. Make stage-context resolution and harness-agent-context construction async, then await them in new-turn, resume, and interrupt paths.
3. Await project detail collection in scheduled and on-demand status reporting.
4. Keep all existing fallback and best-effort error handling.

### Task 3: Verify the minimal change

**Files:**
- Inspect only the files modified above.

1. Review the diff for unrelated formatting or behavior changes.
2. Run ESLint only on modified TypeScript files, without `--fix`.
3. Run `npm run typecheck:node`.
4. Run the existing `tests/goals-runtime-harness.spec.ts` test.
5. Do not run a production build and do not add or modify tests.
