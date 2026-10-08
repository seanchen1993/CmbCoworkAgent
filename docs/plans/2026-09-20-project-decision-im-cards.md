# Project Decision IM Cards Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Render project-mode Human Gate and Biz Retry decisions as interactive IM cards while preserving the existing notification and domain decision paths.

**Architecture:** `app_notifications` remains the only persisted source of truth. Cards use the existing publisher, interaction store, receipt router, and notification lifecycle; card receipts and short codes converge on the existing `decideNotification` handlers. A rejected card send falls back to the current short-code text, and terminal notification lifecycle events replace live cards with static outcomes.

**Tech Stack:** TypeScript, Electron main process services, Vitest/tsx contract tests, Zhaohu custom-card gateway V1.

---

### Task 1: Extend the card contract and pure builders

**Files:**
- Modify: `src/shared/im-gateway-contract.ts`
- Modify: `src/main/services/im/card-builder.ts`
- Test: `tests/im-card-interaction.spec.ts`

**Steps:**
1. Add `human_gate` and `biz_retry` to `ImCardInteractionKind` and its runtime allowlist.
2. Add pure builders for pending Human Gate, pending Biz Retry, and terminal project-decision cards.
3. Render Biz Retry as a required action selector plus an optional continuation-message input.
4. Add builder and contract assertions, then run `npx tsx tests/im-card-interaction.spec.ts`.

### Task 2: Route project card receipts into existing decisions

**Files:**
- Modify: `src/main/services/im/card-receipt-router.ts`
- Modify: `src/main/services/im/human-gate-adapter.ts`
- Modify: `src/main/services/im/biz-retry-adapter.ts`
- Test: `tests/im-card-interaction.spec.ts`

**Steps:**
1. Add card-resolution methods to the two adapters; both short-code and card methods must call the same existing notification decision entry.
2. Add explicit receipt-router branches for `human_gate` and `biz_retry`.
3. Validate Human Gate button suffixes and Biz Retry feedback before invoking domain logic.
4. Keep invalid or temporarily rejected submissions retryable.
5. Run the focused card interaction test.

### Task 3: Publish cards and synchronize terminal state

**Files:**
- Modify: `src/main/services/im/human-gate-adapter.ts`
- Modify: `src/main/services/im/biz-retry-adapter.ts`
- Test: `src/main/services/notification-pipeline.test.ts`
- Test: `tests/im-card-interaction.spec.ts`

**Steps:**
1. Publish the card before the existing text notification.
2. Suppress text only when the gateway accepts the card; otherwise retain the current short-code fallback.
3. Use `notificationId` as the card request reference so notification lifecycle completion can locate it directly.
4. On `ended` or IM-channel disablement, remove the short code and replace the card with a static outcome derived from `status`, `action`, `channel`, and `result`.
5. Cover APP-to-IM update, IM-to-APP completion, send failure fallback, invalid submissions, and one-winner races.

### Task 4: Focused verification

**Files:**
- Verify only files changed by Tasks 1–3.

**Steps:**
1. Run `npx tsx tests/im-card-interaction.spec.ts`.
2. Run `npx vitest run src/main/services/notification-pipeline.test.ts`.
3. Run `npm run typecheck:node`.
4. Run ESLint only against the modified TypeScript files, without `--fix`.
5. Review `git diff --check` and the scoped diff for unrelated formatting.
