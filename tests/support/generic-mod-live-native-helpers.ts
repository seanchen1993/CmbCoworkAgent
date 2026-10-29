import assert from "node:assert/strict"
import type { Page } from "playwright"
import type { DevelopmentApi, DevelopmentStatus, DevelopmentTrialStatus } from "../../src/shared/mods/development"
import { normalizeWorkspacePathKey } from "../../src/shared/workspace-path"

type LiveRelay = {
  phase(name: string): void
  failure(): string | undefined
  inFlight(): number
}

/** Native UI/public preload only. The model supplies all draft files. */
export function genericModNativeJourney(
  page: Page,
  threadId: string,
  workspace: string,
  relay: LiveRelay,
  deadline: number
) {
  let authoredCandidates: DevelopmentTrialStatus[] = []
  const panel = () => page.getByRole("dialog", { name: "插件创作工作区", exact: true })
  const chat = () => page.locator(`[data-chat-thread-id=${JSON.stringify(threadId)}]`)
  const status = () =>
    page.evaluate((input) => window.api.mods.development.status(input),
      { threadId } satisfies Parameters<DevelopmentApi["status"]>[0])
  async function until<T>(label: string, read: () => Promise<T | undefined>, limit = 90_000) {
    const end = Math.min(deadline, Date.now() + limit)
    while (Date.now() < end) {
      assert(!relay.failure(), relay.failure())
      const value = await read()
      if (value !== undefined) return value
      await new Promise((done) => setTimeout(done, 250))
    }
    throw Error(`GENERIC_MOD_TIMEOUT_${label}`)
  }
  async function closePanel() {
    if (await panel().isVisible())
      await panel().getByRole("button", { name: "Close", exact: true }).click()
  }
  async function openPanel() {
    if (!(await panel().isVisible())) await chat().locator('[data-app-guide="workspace"]').click()
  }
  async function idle() {
    let idleAt = 0
    await until("IDLE", async () => {
      const busy = await page
        .getByRole("button", { name: /停止生成|停止响应|停止运行/, includeHidden: true })
        .count()
      if (busy || relay.inFlight()) idleAt = 0
      else idleAt ||= Date.now()
      return idleAt && Date.now() - idleAt >= 1500 ? true : undefined
    }, 420_000)
  }
  async function author(phase: string, prompt: string): Promise<DevelopmentStatus> {
    relay.phase(phase)
    const before = (await status()).drafts.map((draft) => draft.digest)
    await closePanel()
    await page.locator("textarea.composer-textarea").fill(prompt)
    await page.getByRole("button", { name: "发送消息", exact: true }).click()
    await until("AUTHOR", async () => {
      const approvals = await page.evaluate(
        (id) => window.api.sandbox.getPendingApprovals(id), threadId
      )
      assert.equal(approvals.length, 0, "Draft authoring cannot run arbitrary host commands")
      const current = await status()
      return current.trials.some((trial) => ["needs-approval", "active"].includes(trial.phase) &&
        current.drafts.some((draft) => draft.id === trial.draftId &&
          draft.revision === trial.revision && draft.digest === trial.bundleDigest &&
          !before.includes(draft.digest))) ||
        (current.reuse?.phase === "needs-approval" && current.drafts.some((draft) =>
          draft.id === current.reuse?.draftId && draft.revision === current.reuse.revision &&
          draft.digest === current.reuse.sourceDigest && !before.includes(draft.digest)))
        ? current : undefined
    }, 420_000)
    await idle()
    const result = await status()
    authoredCandidates = result.trials.filter((trial) => result.drafts.some((draft) =>
      draft.id === trial.draftId && draft.revision === trial.revision &&
      draft.digest === trial.bundleDigest && !before.includes(draft.digest)))
    return result
  }
  async function activate() {
    const current = await status()
    const pending = authoredCandidates.length ? authoredCandidates
      : current.trials.filter((trial) => trial.phase === "needs-approval")
    assert(pending.length > 0, "Activation requires an exact authored candidate")
    const currentCandidates = pending.map((expected) => current.trials.find((trial) =>
      trial.componentId === expected.componentId && trial.draftId === expected.draftId &&
      trial.revision === expected.revision && trial.bundleDigest === expected.bundleDigest))
    if (currentCandidates.every((candidate) => candidate?.phase === "active")) {
      await closePanel()
      return
    }
    assert(currentCandidates.some((candidate) => candidate?.phase === "needs-approval"),
      "A candidate must be active or require native confirmation")
    await openPanel()
    await panel().getByRole("button", { name: "确认并应用到这段聊天", exact: true }).click()
    await until("ACTIVE", async () => {
      const current = await status()
      const candidates = pending.map((expected) => current.trials.find((trial) =>
        trial.componentId === expected.componentId && trial.draftId === expected.draftId &&
        trial.revision === expected.revision && trial.bundleDigest === expected.bundleDigest))
      for (const candidate of candidates)
        assert(!candidate || !["failed", "unknown"].includes(candidate.phase), candidate?.error)
      return candidates.every((candidate) => candidate?.phase === "active") ? true : undefined
    })
    await closePanel()
  }
  async function reuse(draft: DevelopmentStatus["drafts"][number]) {
    const nativeWorkspace = (await status()).workspace
    assert.equal(normalizeWorkspacePathKey(nativeWorkspace), normalizeWorkspacePathKey(workspace))
    const input = {
      threadId, expectedWorkspace: nativeWorkspace, id: draft.id, revision: draft.revision
    } satisfies Parameters<DevelopmentApi["requestReuse"]>[0]
    const existing = await status()
    const prepared = existing.reuse?.phase === "needs-approval" &&
      existing.reuse.draftId === draft.id && existing.reuse.revision === draft.revision &&
      existing.reuse.sourceDigest === draft.digest ? existing : await page.evaluate((input) =>
        window.api.mods.development.requestReuse(input), input)
    const plan = prepared.reuse
    assert(plan?.planId && plan.draftId === draft.id && plan.revision === draft.revision &&
      plan.sourceDigest === draft.digest && plan.phase === "needs-approval",
    "Reuse confirmation must belong to this exact draft revision")
    await openPanel()
    const advanced = panel().locator('details[data-creator-section="create"]')
    if (!(await advanced.evaluate((element) => (element as HTMLDetailsElement).open)))
      await advanced.locator(":scope > summary").click()
    await panel().getByRole("button", { name: "确认保存并复用", exact: true }).click()
    const result = await until("REUSE", async () => {
      const current = await status()
      assert.equal(current.reuse?.planId, plan.planId, "Reuse plan must not change during confirmation")
      assert(!["failed", "unknown"].includes(current.reuse?.phase ?? ""), current.reuse?.error)
      return current.reuse?.phase === "active" && current.reuse.draftId === draft.id &&
        current.reuse.revision === draft.revision && current.reuse.sourceDigest === draft.digest
        ? current : undefined
    })
    await closePanel()
    return result
  }
  return { until, status, author, activate, reuse, openPanel, closePanel, idle }
}
