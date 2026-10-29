import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Page } from "playwright"
import { openCreatorStep } from "./creator-navigation"
import { normalizeWorkspacePathKey } from "../../src/shared/workspace-path"
import type { DevelopmentReuseStatus } from "../../src/shared/mods/development"
import type { AuthoringSourceBundle } from "../../src/main/mods/devtools/authoring-bundle"

type LiveCreatorDependencyReview = Pick<
  DevelopmentReuseStatus,
  | "draftId"
  | "revision"
  | "sourceDigest"
  | "compiledDigest"
  | "targetProfileDigest"
  | "capabilities"
> & { threadId: string; workspace: string; planId: string; source: AuthoringSourceBundle }

/** Reusing a review never creates approval or replaces a review of a different exact plan. */
export function preserveLiveCreatorDependencyReview(input: {
  artifacts: string
  review: LiveCreatorDependencyReview
  expectedPlanId?: string
}) {
  const { review } = input
  const digest = createHash("sha256").update(JSON.stringify(review)).digest("hex")
  const directory = join(input.artifacts, "dependency-review")
  const proposal = join(directory, `${digest}.proposal.json`)
  const approval = join(directory, `${digest}.approved.json`)
  const envelope = { digest, ...review }
  if (input.expectedPlanId !== undefined) {
    assert.equal(review.planId, input.expectedPlanId, "LIVE_DEPENDENCY_PLAN_REPLACED")
    assert(existsSync(directory), "LIVE_DEPENDENCY_ORIGINAL_REVIEW_REQUIRED")
    const originals = readdirSync(directory)
      .filter((name) => name.endsWith(".proposal.json"))
      .map((name) => ({
        path: join(directory, name),
        value: JSON.parse(readFileSync(join(directory, name), "utf8"))
      }))
      .filter(
        ({ value }) =>
          value.planId === input.expectedPlanId &&
          value.threadId === review.threadId &&
          value.workspace === review.workspace
      )
    assert.equal(originals.length, 1, "LIVE_DEPENDENCY_ORIGINAL_REVIEW_REQUIRED")
    assert.deepEqual(originals[0].value, envelope, "LIVE_DEPENDENCY_REVIEW_MISMATCH")
    assert.equal(originals[0].path, proposal, "LIVE_DEPENDENCY_REVIEW_MISMATCH")
  } else {
    mkdirSync(directory, { recursive: true })
    if (existsSync(proposal))
      assert.deepEqual(
        JSON.parse(readFileSync(proposal, "utf8")),
        envelope,
        "LIVE_DEPENDENCY_REVIEW_MISMATCH"
      )
    else writeFileSync(proposal, JSON.stringify(envelope, null, 2), { flag: "wx" })
  }
  return { digest, proposal, approval }
}

/** A test reviewer checks exact source before the original native installation consent. */
export async function reviewLiveCreatorDependency(input: {
  page: Page
  threadId: string
  workspace: string
  artifacts: string
  deadline: number
  /** Diagnostic continuation must match an already reviewed original plan; never create one. */
  expectedPlanId?: string
}) {
  const { page, threadId, workspace } = input
  const read = () =>
    page.evaluate((id) => window.api.mods.development.status({ threadId: id }), threadId)
  const before = await read()
  const plan = before.reuse
  assert(plan?.phase === "needs-approval" && plan.planId, "LIVE_DEPENDENCY_REVIEW_NOT_READY")
  if (input.expectedPlanId !== undefined)
    assert.equal(plan.planId, input.expectedPlanId, "LIVE_DEPENDENCY_PLAN_REPLACED")
  for (const digest of [plan.sourceDigest, plan.compiledDigest, plan.targetProfileDigest])
    assert.match(digest ?? "", /^[a-f0-9]{64}$/, "LIVE_DEPENDENCY_EXACT_IDENTITY_REQUIRED")
  assert.equal(
    normalizeWorkspacePathKey(before.workspace),
    normalizeWorkspacePathKey(workspace),
    "LIVE_DEPENDENCY_SCOPE_CHANGED"
  )
  const document = await page.evaluate(
    async ({ threadId, workspace, digest }) => {
      const list = await window.api.mods.authoring.list(threadId)
      if (list.workspace !== workspace) throw Error("LIVE_DEPENDENCY_AUTHORING_SCOPE_CHANGED")
      for (const draft of list.drafts) {
        const source = await window.api.mods.authoring.read({
          threadId,
          expectedWorkspace: workspace,
          id: draft.id
        })
        if (source.source.digest === digest) return source
      }
      return null
    },
    { threadId, workspace: before.workspace, digest: plan.sourceDigest }
  )
  assert(document, "LIVE_DEPENDENCY_EXACT_SOURCE_REQUIRED")
  const review = {
    threadId,
    workspace,
    planId: plan.planId,
    draftId: plan.draftId,
    revision: plan.revision,
    sourceDigest: plan.sourceDigest,
    compiledDigest: plan.compiledDigest,
    targetProfileDigest: plan.targetProfileDigest,
    capabilities: plan.capabilities,
    source: document.source
  }
  const { digest, proposal, approval } = preserveLiveCreatorDependencyReview({
    artifacts: input.artifacts,
    review,
    expectedPlanId: input.expectedPlanId
  })
  console.log(`LIVE_DEPENDENCY_REVIEW ${proposal}`)
  const reviewEnd = Math.min(input.deadline, Date.now() + 120000)
  while (!existsSync(approval) && Date.now() < reviewEnd)
    await new Promise((done) => setTimeout(done, 250))
  assert(existsSync(approval), "LIVE_DEPENDENCY_EXPLICIT_REVIEW_REQUIRED")
  const accepted = JSON.parse(readFileSync(approval, "utf8"))
  assert.deepEqual(accepted, { digest, decision: "approve" }, "LIVE_DEPENDENCY_REVIEW_MISMATCH")
  const current = await read()
  const identityKeys = [
    "planId",
    "draftId",
    "revision",
    "sourceDigest",
    "compiledDigest",
    "targetProfileDigest"
  ] as const
  for (const key of identityKeys)
    assert.equal(current.reuse?.[key], plan[key], "LIVE_DEPENDENCY_IDENTITY_CHANGED")
  assert.deepEqual(
    current.reuse?.capabilities,
    plan.capabilities,
    "LIVE_DEPENDENCY_IDENTITY_CHANGED"
  )
  assert.equal(current.reuse?.phase, "needs-approval", "LIVE_DEPENDENCY_PHASE_CHANGED")
  const panel = await openCreatorStep(page, "delivery")
  const card = panel.getByRole("article", { name: "保存并在其他聊天复用", exact: true })
  if (!(await card.isVisible())) {
    const summary = panel.getByText("组件与高级设置", { exact: true })
    if (!(await summary.evaluate((element) => (element.parentElement as HTMLDetailsElement).open)))
      await summary.click()
  }
  const feedback = panel
    .getByRole("status")
    .filter({
      has: page.getByRole("button", { name: "重新读取状态", exact: true })
    })
    .first()
  await card.getByRole("button", { name: "确认保存并复用", exact: true }).click()
  while (Date.now() < input.deadline) {
    const after = await read()
    for (const key of identityKeys)
      assert.equal(after.reuse?.[key], plan[key], "LIVE_DEPENDENCY_IDENTITY_CHANGED")
    assert.deepEqual(
      after.reuse?.capabilities,
      plan.capabilities,
      "LIVE_DEPENDENCY_IDENTITY_CHANGED"
    )
    assert(!(await feedback.isVisible()), "LIVE_DEPENDENCY_NATIVE_APPROVAL_FAILED")
    if (after.reuse?.phase === "active") {
      await panel.getByRole("button", { name: "Close", exact: true }).click()
      return { ...review, source: undefined, nativeUIConsent: true, reviewDigest: digest }
    }
    assert(
      !["failed", "unknown"].includes(after.reuse?.phase ?? ""),
      after.reuse?.error ?? "LIVE_DEPENDENCY_NOT_INSTALLED"
    )
    assert(
      after.reuse?.phase === "needs-approval" || after.reuse?.phase === "applying",
      "LIVE_DEPENDENCY_PHASE_CHANGED"
    )
    await new Promise((done) => setTimeout(done, 200))
  }
  throw Error("LIVE_DEPENDENCY_INSTALL_TIMEOUT")
}
