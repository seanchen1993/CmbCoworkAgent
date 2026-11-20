# Delivery Days Sort Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the project metrics table sort “特性上线耗时” by `deliveryDays` in Elasticsearch and align all legacy duration labels with that wording.

**Architecture:** Add `deliveryDays` to the shared sort contract and generate an Elasticsearch 7.6-compatible Painless numeric sort from `approvedDate` and `firstOnlineDate`. Keep missing or invalid durations last in both directions, use `prjCode` as the stable tie-breaker, and retain application-side sorting only for metrics derived from other indexes.

**Tech Stack:** TypeScript, React, Electron IPC, Elasticsearch 7.6 Painless DSL.

---

### Task 1: Update the shared sorting contract

**Files:**
- Modify: `src/shared/project-metrics.ts`

**Step 1:** Replace the sortable `firstOnlineDate` key with `deliveryDays`.

**Step 2:** Run the Node and Web TypeScript checks after all dependent call sites are updated.

### Task 2: Sort delivery duration in Elasticsearch

**Files:**
- Modify: `src/main/ipc/dashboard-project-metrics.ts`

**Step 1:** Add an Elasticsearch `_script` numeric sort that calculates milliseconds between `approvedDate` and `firstOnlineDate`.

**Step 2:** Return an order-specific sentinel for missing or invalid dates so those projects remain last for ascending and descending sorts.

**Step 3:** Make `deliveryDays` the default sort and keep `prjCode` ascending as the deterministic tie-breaker.

**Step 4:** Align mock-data sorting with the same `deliveryDays` semantics.

### Task 3: Rename user-facing labels and documentation

**Files:**
- Modify: `src/renderer/src/components/dashboard/panels/ProjectMetricsSection.tsx`
- Modify: `docs/项目度量看板设计.md`

**Step 1:** Rename the summary, table, tooltip, and detail labels to “特性上线耗时”.

**Step 2:** Document `deliveryDays` as the default and supported sort key while retaining `firstOnlineDate` as the raw source date.

### Task 4: Verify the implementation

**Files:**
- Check only the files modified by this task.

**Step 1:** Run ESLint on the three modified TypeScript/TSX files without `--fix`.

**Step 2:** Run `typecheck:node` and `typecheck:web`.

**Step 3:** Confirm no legacy duration labels remain and inspect the final diff for unrelated changes. Do not add or rewrite tests under the repository working agreement.
