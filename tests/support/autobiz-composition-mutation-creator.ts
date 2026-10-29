/** Original Creator UI joined to the controlled AutoBiz native runtime, without source edits. */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import type { ElectronApplication, Page } from "playwright"
import type { LocalProjectView } from "../../src/shared/project-runtime/platform-api"
import type { CreatorProjectTrialJourney } from "../../src/shared/mods/creator-trial-journey"
import type { DevelopmentProjectTrialRequest } from "../../src/shared/mods/development"
import { createAuthoringSourceBundle } from "../../src/main/mods/devtools/authoring-bundle"
import { normalizeWorkspacePathKey } from "../../src/shared/workspace-path"
import { openCreatorProjectPreview, openCreatorStep } from "./creator-navigation"
import { enterModsCreatorChat } from "./mods-sidebar-navigation"

export function mutationCreatorIdentity(input: {
  profile: string
  files: ReadonlyArray<{ path: string; bytes: Buffer }>
  evidencePath?: string
  threadId?: string
}) {
  const bundle = createAuthoringSourceBundle(
    input.files.map((file) => ({
      path: file.path,
      text: new TextDecoder("utf-8", { fatal: true }).decode(file.bytes)
    }))
  )
  const evidencePath = resolve(input.evidencePath ?? join(input.profile, "evidence.json"))
  const evidenceBytes = readFileSync(evidencePath)
  const evidenceSha256 = createHash("sha256").update(evidenceBytes).digest("hex")
  const evidence = JSON.parse(evidenceBytes.toString("utf8")) as {
    observations?: Array<{
      threadId?: string
      authoring?: { projectTrial?: { id?: string; revision?: number; digest?: string } }
    }>
  }
  const observations = (evidence.observations ?? []).filter(
    (observation) => observation.authoring?.projectTrial?.digest === bundle.digest
  )
  const matching = [...new Set(observations.map((observation) => observation.threadId))]
  const threadId = input.threadId ?? (matching.length === 1 ? matching[0] : undefined)
  assert(
    threadId && /^[a-f0-9-]{36}$/.test(threadId),
    "AUTOBIZ_CREATOR_ORIGINAL_THREAD_REQUIRED: supply the original author thread, never a new thread"
  )
  assert(matching.includes(threadId), "AUTOBIZ_CREATOR_AUTHOR_EVIDENCE_BINDING_REQUIRED")
  const requests = observations
    .filter((observation) => observation.threadId === threadId)
    .map((observation) => observation.authoring!.projectTrial!)
  assert(
    requests.every(
      (request) =>
        typeof request.id === "string" &&
        /^[a-f0-9-]{36}$/.test(request.id) &&
        typeof request.revision === "number" &&
        Number.isSafeInteger(request.revision) &&
        request.revision >= 1 &&
        request.revision <= 8
    ) &&
      new Set(requests.map((request) => JSON.stringify([request.id, request.revision]))).size === 1,
    "AUTOBIZ_CREATOR_ORIGINAL_REQUEST_REQUIRED"
  )
  const { id: requestId, revision } = requests[0]
  assert(requestId && revision !== undefined, "AUTOBIZ_CREATOR_ORIGINAL_REQUEST_REQUIRED")
  return {
    threadId,
    candidateDigest: bundle.digest,
    requestId,
    revision,
    evidencePath,
    evidenceSha256
  }
}

/** Same source bytes do not authorize a newly recreated native request. */
export function assertMutationCreatorRequest(
  request: Pick<DevelopmentProjectTrialRequest, "id" | "revision" | "digest"> | undefined,
  identity: Pick<
    ReturnType<typeof mutationCreatorIdentity>,
    "requestId" | "revision" | "candidateDigest"
  >
): asserts request is Pick<DevelopmentProjectTrialRequest, "id" | "revision" | "digest"> {
  assert(request, "AUTOBIZ_CREATOR_PROJECT_TRIAL_REQUIRED")
  assert.equal(request.id, identity.requestId, "AUTOBIZ_CREATOR_REQUEST_CHANGED")
  assert.equal(request.revision, identity.revision, "AUTOBIZ_CREATOR_REVISION_CHANGED")
  assert.equal(request.digest, identity.candidateDigest, "AUTOBIZ_CREATOR_CANDIDATE_CHANGED")
}

/** Acceptance of the original native journal projection; this creates no journey or receipt. */
export function assertMutationCreatorPassed(
  journey: CreatorProjectTrialJourney | undefined,
  project: LocalProjectView,
  identity: Pick<ReturnType<typeof mutationCreatorIdentity>, "threadId" | "candidateDigest">
): asserts journey is CreatorProjectTrialJourney {
  assert(journey, "AUTOBIZ_CREATOR_JOURNEY_REQUIRED")
  assert.equal(project.project.status, "completed")
  assert.equal(journey.projectId, project.project.projectId)
  assert.equal(
    normalizeWorkspacePathKey(journey.workspace),
    normalizeWorkspacePathKey(project.project.workspace)
  )
  assert.equal(journey.creatorThreadId, identity.threadId)
  assert.equal(journey.candidateDigest, identity.candidateDigest)
  assert.equal(journey.candidateCurrent, true)
  assert.equal(journey.phase, "passed")
  assert.equal(journey.canDeliver, true)
  assert.equal(journey.operationsTruncated, false)
  assert.deepEqual(
    journey.stages.map((stage) => stage.id),
    project.project.manifest.stages.map((stage) => stage.id)
  )
  for (const [index, stage] of journey.stages.entries())
    assert.deepEqual(
      stage.checks.map((check) => check.id).sort(),
      [...project.project.manifest.stages[index].checkIds].sort()
    )
  assert(
    journey.stages.every(
      (stage) =>
        stage.status === "passed" &&
        stage.checks.length > 0 &&
        stage.checks.every((check) => check.result === "passed")
    )
  )
}

/** A setup-only failure can end through native UI; any prepared/executed work must recover. */
export function assertUnstartedCreatorTrial(project: LocalProjectView, expectedProjectId: string) {
  assert.match(expectedProjectId, /^[a-f0-9-]{36}$/)
  assert.equal(project.project.projectId, expectedProjectId)
  assert.match(project.project.installedPluginId, /^dev-project-preview:[a-f0-9-]{36}$/)
  assert.equal(project.project.version, 1)
  assert.equal(project.project.stageIndex, 0)
  assert.equal(project.project.status, "active")
  assert.deepEqual(project.operations, [])
  assert.equal(project.inputWait, undefined)
  assert.equal(project.resultReview, undefined)
  assert.equal(project.migrationReview, undefined)
  assert.equal(project.importedSource, undefined)
}

/** Delivery may resume a physically completed trial; never manufacture or replay stage receipts. */
export function assertRetainedCompletedCreatorTrial(
  recorded: LocalProjectView,
  current: LocalProjectView
) {
  assert.equal(recorded.project.status, "completed")
  assert.match(recorded.project.installedPluginId, /^dev-project-preview:[a-f0-9-]{36}$/)
  assert(recorded.project.manifest.stages.length > 0)
  assert.equal(recorded.project.stageIndex, recorded.project.manifest.stages.length)
  assert.deepEqual(current.project, recorded.project)
  assert.deepEqual(current.operations, recorded.operations)
  assert.equal(current.inputWait, undefined)
  assert.equal(current.migrationReview, undefined)
  assert(
    current.operations.every((item) =>
      ["transitioned", "failed", "cancelled"].includes(item.status)
    )
  )
  for (const stage of recorded.project.manifest.stages) {
    const operation = current.operations.findLast(
      (item) => item.stageId === stage.id && item.status === "transitioned"
    )
    assert(operation?.execution?.terminal?.outcome === "success")
    assert(stage.checkIds.length > 0)
    for (const checkId of stage.checkIds)
      assert(
        operation.receipts.some(
          (receipt) => receipt.checkId === checkId && receipt.result === "passed"
        )
      )
    assert(operation.receipts.every((receipt) => receipt.result === "passed"))
  }
}

export async function mutationCreatorJourney(input: {
  app: ElectronApplication
  page: Page
  identity: ReturnType<typeof mutationCreatorIdentity>
  deadline: number
  restartUnstartedProjectId?: string
  record(value: Record<string, unknown>): void
}) {
  const { app, page, identity } = input
  const status = () =>
    page.evaluate((threadId) => window.api.mods.development.status({ threadId }), identity.threadId)
  const original = await page.evaluate((id) => window.api.mods.status(id), identity.threadId)
  const originalScope = normalizeWorkspacePathKey(original.workspace)
  assert(originalScope, "AUTOBIZ_CREATOR_AUTHOR_WORKSPACE_REQUIRED")
  const author = await page.evaluate((id) => window.api.threads.get(id), identity.threadId)
  assert(author?.title, "AUTOBIZ_CREATOR_AUTHOR_REQUIRED")
  assert.equal(author.thread_id, identity.threadId, "AUTOBIZ_CREATOR_AUTHOR_CHANGED")
  async function navigateAuthor() {
    // The project-list helper installs a Creator overlay dismissal handler. Remove it
    // before intentionally using the same original Creator UI again.
    const creator = page.getByRole("dialog", { name: "插件创作工作区", exact: true })
    await page.removeLocatorHandler(creator)
    const back = page.getByRole("button", { name: "返回会话", exact: true })
    if (await back.isVisible()) await back.click()
    if (await creator.isVisible())
      await creator.getByRole("button", { name: "Close", exact: true }).click()
    // Returning to chat can reveal its retained workspace dialog after the tab
    // switch. Close that visible dialog normally before selecting the author.
    await page.addLocatorHandler(creator, async () => {
      await creator.getByRole("button", { name: "Close", exact: true }).click()
    })
    try {
      await page.getByRole("tab", { name: "对话模式", exact: true }).click()
      const chat = page.locator(`[data-chat-thread-id=${JSON.stringify(identity.threadId)}]`)
      if (!(await chat.isVisible()))
        await page.getByText(author!.title!, { exact: true }).first().click()
      await chat.waitFor({ state: "visible" })
    } finally {
      await page.removeLocatorHandler(creator)
    }
  }
  await navigateAuthor()
  // Creator admission is intentionally process-local. Re-enter through the original
  // chat control before asking for the durable request; this creates no request or trial.
  await enterModsCreatorChat(page, identity.threadId, original.workspace)
  const entered = await status()
  assert.equal(entered.threadId, identity.threadId, "AUTOBIZ_CREATOR_AUTHOR_CHANGED")
  assert.equal(
    normalizeWorkspacePathKey(entered.workspace),
    originalScope,
    "AUTOBIZ_CREATOR_AUTHOR_WORKSPACE_CHANGED"
  )
  assert(entered.enabled && entered.mode === "creator", "AUTOBIZ_CREATOR_MODE_REQUIRED")
  const request = entered.projectTrial
  assertMutationCreatorRequest(request, identity)
  async function current() {
    assert.equal(
      createHash("sha256").update(readFileSync(identity.evidencePath)).digest("hex"),
      identity.evidenceSha256,
      "AUTOBIZ_CREATOR_ORIGINAL_AUTHOR_EVIDENCE_CHANGED"
    )
    const value = await status()
    assert.equal(value.threadId, identity.threadId, "AUTOBIZ_CREATOR_AUTHOR_CHANGED")
    assert.equal(
      normalizeWorkspacePathKey(value.workspace),
      originalScope,
      "AUTOBIZ_CREATOR_AUTHOR_WORKSPACE_CHANGED"
    )
    assert(value.enabled && value.mode === "creator", "AUTOBIZ_CREATOR_MODE_REQUIRED")
    assertMutationCreatorRequest(value.projectTrial, identity)
    return value
  }
  async function until<T>(read: () => Promise<T>, accept: (value: T) => boolean, code: string) {
    const end = Math.min(input.deadline, Date.now() + 30000)
    do {
      const value = await read()
      if (accept(value)) return value
      await page.waitForTimeout(200)
    } while (Date.now() < end)
    throw Error(code)
  }
  async function openAuthor() {
    await navigateAuthor()
    await current()
  }
  input.record({
    type: "creator-original-scope",
    ...identity,
    authorWorkspace: original.workspace,
    requestId: request.id,
    revision: request.revision,
    runtimeModel: "controlled loopback decisions; native production execution and checks"
  })
  return {
    inspect: current,
    async createTrial() {
      await openAuthor()
      const panel = await openCreatorProjectPreview(page)
      let drafts = await page.evaluate(
        (id) => window.api.harnessBoard.localProjects.preview.list(id),
        identity.threadId
      )
      let draft = drafts.drafts.find((value) => value.id === request.draftId)
      assert(draft, "AUTOBIZ_CREATOR_ORIGINAL_DRAFT_REQUIRED")
      assert.equal(draft.digest, identity.candidateDigest)
      assert.equal(draft.revision, request.revision)
      let endedUnstartedTrial = false
      if (input.restartUnstartedProjectId) {
        const projectId = input.restartUnstartedProjectId
        assert.equal(request.journey?.projectId, projectId)
        assert.equal(draft.recovery?.projectId, projectId)
        assert.equal(draft.recovery?.status, "needs-confirmation")
        assert.equal(draft.recovery?.hasUnconfirmedEffects, false)
        const previous = await page.evaluate(
          (id) => window.api.harnessBoard.localProjects.get(id),
          projectId
        )
        assertUnstartedCreatorTrial(previous, projectId)
        const oldCard = panel.locator("article").filter({
          has: page.getByText(`${draft.name} · 版本 ${draft.revision}`, { exact: true })
        })
        await oldCard
          .getByRole("button", {
            name: "结束保留的试用（保留文件）",
            exact: true
          })
          .click()
        drafts = await until(
          () =>
            page.evaluate(
              (id) => window.api.harnessBoard.localProjects.preview.list(id),
              identity.threadId
            ),
          (value) => {
            const current = value.drafts.find((item) => item.id === request.draftId)
            return Boolean(current && !current.projectId && !current.recovery)
          },
          "AUTOBIZ_CREATOR_UNSTARTED_TRIAL_END_TIMEOUT"
        )
        const preserved = await page.evaluate(
          (id) => window.api.harnessBoard.localProjects.get(id),
          projectId
        )
        assertUnstartedCreatorTrial(preserved, projectId)
        assert.deepEqual(preserved.project, previous.project)
        input.record({ type: "creator-ended-unstarted-trial-via-native-ui", previous, preserved })
        draft = drafts.drafts.find((value) => value.id === request.draftId)
        assert(draft)
        endedUnstartedTrial = true
      }
      assert(
        !draft.projectId && !draft.recovery && (!request.journey?.projectId || endedUnstartedTrial),
        "AUTOBIZ_CREATOR_RETAINED_TRIAL_REQUIRES_EXPLICIT_RECOVERY: never fork or overwrite it"
      )
      const card = panel.locator("article").filter({
        has: page.getByText(`${draft.name} · 版本 ${draft.revision}`, { exact: true })
      })
      await card.getByRole("button", { name: "开始试用", exact: true }).click()
      const observed = await until(
        () =>
          page.evaluate(
            (id) => window.api.harnessBoard.localProjects.preview.list(id),
            identity.threadId
          ),
        (value) => Boolean(value.drafts.find((value) => value.id === request.draftId)?.projectId),
        "AUTOBIZ_CREATOR_TRIAL_CREATION_TIMEOUT"
      )
      const projectId = observed.drafts.find((value) => value.id === request.draftId)!.projectId!
      const created = await page.evaluate(
        (id) => window.api.harnessBoard.localProjects.get(id),
        projectId
      )
      assert(created.project.installedPluginId.startsWith("dev-project-preview:"))
      assert.equal(created.operations.length, 0, "AUTOBIZ_CREATOR_TRIAL_PREEXECUTED")
      const bound = await current()
      assert.equal(bound.projectTrial?.journey?.projectId, projectId)
      assert.equal(bound.projectTrial?.journey?.candidateDigest, identity.candidateDigest)
      input.record({
        type: "creator-trial-created-by-original-ui",
        created,
        binding: bound.projectTrial?.journey
      })
      return created
    },
    async assertPassed(project: LocalProjectView) {
      const state = await current()
      const journey = state.projectTrial?.journey
      assertMutationCreatorPassed(journey, project, identity)
      input.record({ type: "creator-original-journal-journey-passed", journey })
      return journey
    },
    async saveAndStart(trial: LocalProjectView, workspace: string, reuseInstalledDelivery = false) {
      await openAuthor()
      let state = await current()
      assert.equal(state.projectTrial?.journey?.phase, "passed")
      assert.equal(state.projectTrial?.journey?.canDeliver, true)
      const panel = await openCreatorStep(page, "delivery")
      const card = panel.getByRole("region", { name: "项目候选保存为新插件", exact: true })
      if (state.projectDelivery?.phase === "unknown") {
        const historical = state.projectDelivery
        assert.equal(historical.canReconcile, true, "AUTOBIZ_CREATOR_RECONCILIATION_REQUIRED")
        await card.getByRole("button", { name: "核对实际交付结果", exact: true }).click()
        state = await until(
          current,
          (value) => value.projectDelivery?.phase !== "unknown",
          "AUTOBIZ_CREATOR_RECONCILIATION_TIMEOUT"
        )
        assert.equal(state.projectDelivery?.id, historical.id)
        assert.equal(state.projectDelivery?.sourceDigest, historical.sourceDigest)
        assert(
          ["failed", "installed", "exported"].includes(state.projectDelivery!.phase),
          "AUTOBIZ_CREATOR_RECONCILIATION_MUST_OBSERVE_ACTUAL_OUTCOME"
        )
        input.record({
          type: "creator-historical-delivery-reconciled-by-original-ui",
          before: historical,
          after: state.projectDelivery
        })
      }
      if (
        state.projectDelivery?.phase === "installed" &&
        state.projectDelivery.requestId === request.id &&
        state.projectDelivery.sourceDigest === identity.candidateDigest
      ) {
        assert(reuseInstalledDelivery, "AUTOBIZ_CREATOR_FRESH_DELIVERY_REQUIRED")
        input.record({ type: "creator-existing-delivery-read-without-reinstallation" })
      } else {
        await card.getByRole("button", { name: "保存插件", exact: true }).click()
      }
      const installed = await until(
        current,
        (value) => value.projectDelivery?.phase === "installed",
        "AUTOBIZ_CREATOR_DELIVERY_INSTALL_TIMEOUT"
      )
      const delivery = installed.projectDelivery!
      assert.equal(delivery.sourceDigest, identity.candidateDigest)
      assert.equal(delivery.requestId, request.id)
      assert(delivery.pluginId && /^[a-f0-9]{64}$/.test(delivery.digest))
      const plugin = await page.evaluate(
        async (id) => (await window.api.plugins.list()).find((value) => value.id === id),
        delivery.pluginId
      )
      assert(plugin)
      assert.equal(plugin.name, delivery.name)
      assert.equal(plugin.version, delivery.version)
      input.record({
        type: "creator-original-delivery-saved",
        delivery,
        plugin,
        validation:
          "Installation identity only; this new package has not yet run its ordinary project"
      })
      const before = await page.evaluate(() => window.api.harnessBoard.localProjects.list())
      await card.getByRole("button", { name: "开始使用", exact: true }).click()
      const form = page.locator("form").filter({
        has: page.getByLabel("项目名称", { exact: true })
      })
      try {
        await form.waitFor({ state: "visible" })
      } catch (error) {
        input.record({
          type: "creator-start-use-form-not-visible",
          body: (await page.locator("body").innerText()).slice(-30000),
          native: await page.evaluate(
            async (pluginId) => ({
              plugin: (await window.api.plugins.list()).find((item) => item.id === pluginId),
              templates: await window.api.harnessBoard.localProjects.templates()
            }),
            delivery.pluginId
          )
        })
        throw error
      }
      const selectedPlugin = page
        .getByRole("dialog", { name: "新建项目", exact: true })
        .getByRole("button", {
          name: `选择插件，当前：${delivery.name} · ${delivery.version}`,
          exact: true
        })
      await selectedPlugin.waitFor()
      assert(await selectedPlugin.isDisabled(), "Start use must pin the saved plugin identity")
      await form
        .getByLabel("项目名称", { exact: true })
        .fill("AutoBiz Creator saved plugin ordinary project")
      await form.getByLabel("希望完成什么", { exact: true }).fill(trial.project.goal)
      mkdirSync(workspace, { recursive: true })
      await app.evaluate(({ dialog }, selected) => {
        const original = dialog.showOpenDialog
        dialog.showOpenDialog = (async (...args: unknown[]) => {
          const options = args.at(-1) as { title?: string }
          if (options?.title !== "选择任务工作目录") return Reflect.apply(original, dialog, args)
          dialog.showOpenDialog = original
          return { canceled: false, filePaths: [selected] }
        }) as typeof dialog.showOpenDialog
      }, workspace)
      await form.getByRole("button", { name: "选择工作目录", exact: true }).click()
      await form.getByRole("button", { name: "创建项目", exact: true }).click()
      await form.waitFor({ state: "hidden" })
      const after = await page.evaluate(() => window.api.harnessBoard.localProjects.list())
      const added = after.filter(
        (value) => !before.some((old) => old.projectId === value.projectId)
      )
      assert.equal(added.length, 1, "AUTOBIZ_CREATOR_START_USE_CREATION_NOT_UNIQUE")
      const ordinary = await page.evaluate(
        (id) => window.api.harnessBoard.localProjects.get(id),
        added[0].projectId
      )
      assert.equal(ordinary.project.installedPluginId, delivery.pluginId)
      assert.equal(
        normalizeWorkspacePathKey(ordinary.project.workspace),
        normalizeWorkspacePathKey(workspace)
      )
      assert.equal(ordinary.project.packageVersion, delivery.version)
      assert.equal(ordinary.operations.length, 0)
      assert.deepEqual(ordinary.project.manifest.stages, trial.project.manifest.stages)
      assert.deepEqual(ordinary.project.manifest.artifacts, trial.project.manifest.artifacts)
      assert.deepEqual(ordinary.project.manifest.checks, trial.project.manifest.checks)
      input.record({ type: "creator-original-start-use-created-ordinary", ordinary, delivery })
      return { ordinary, delivery, plugin }
    }
  }
}

/** Save only declared public values via the actual field controls and verify native readback. */
export async function saveMutationProjectConfigurationViaUi(input: {
  page: Page
  view: LocalProjectView
  values: Record<string, string | number>
  record(value: Record<string, unknown>): void
}) {
  const { page, view } = input
  const read = () =>
    page.evaluate(
      (id) => window.api.harnessBoard.localProjects.mods.read(id),
      view.project.projectId
    )
  let review = await read()
  assert.equal(
    normalizeWorkspacePathKey(review.workspace),
    normalizeWorkspacePathKey(view.project.workspace)
  )
  const region = page.getByRole("region", { name: "本包功能权限", exact: true })
  const settings = region.locator("details").first()
  for (const [key, value] of Object.entries(input.values)) {
    assert(review.source?.pluginId, "AUTOBIZ_CREATOR_MAIN_CONFIGURATION_REQUIRED")
    const config = await page.evaluate(
      ({ id, pluginId }) =>
        window.api.harnessBoard.localProjects.mods.config.userConfig(id, pluginId),
      { id: view.project.projectId, pluginId: review.source.pluginId }
    )
    const field = config.fields.find((field) => field.key === key)
    assert(
      field && !field.sensitive && !field.multiple,
      `AUTOBIZ_CONFIGURATION_FIELD_REQUIRED:${key}`
    )
    assert.equal(
      typeof value,
      field.type === "number" ? "number" : "string",
      `Native field type must remain intact: ${key}`
    )
    // Readiness refreshes or a fresh source scope may change the parent panel between fields.
    if (!(await settings.evaluate((element) => (element as HTMLDetailsElement).open)))
      await settings.locator(":scope > summary").click()
    const form = region.locator(
      `[data-function-user-config=${JSON.stringify(review.source.pluginId)}]`
    )
    if (!(await form.evaluate((element) => (element as HTMLDetailsElement).open)))
      await form.locator("summary").first().click()
    const control = form.locator(
      `[id=${JSON.stringify(`plugin-param-${review.source.pluginId}-${key}`)}]`
    )
    await control.fill(String(value))
    await control.locator("xpath=../..").getByRole("button", { name: "保存", exact: true }).click()
    const end = Date.now() + 15000
    let saved = false
    while (!saved && Date.now() < end) {
      const actual = await page.evaluate(
        ({ id, pluginId }) =>
          window.api.harnessBoard.localProjects.mods.config.userConfig(id, pluginId),
        { id: view.project.projectId, pluginId: review.source.pluginId }
      )
      saved = actual.fields.find((field) => field.key === key)?.value === value
      if (!saved) await page.waitForTimeout(100)
    }
    assert(saved, `AUTOBIZ_CONFIGURATION_NATIVE_READBACK_FAILED:${key}`)
    input.record({
      type: "creator-project-ui-config-saved",
      projectId: view.project.projectId,
      workspace: view.project.workspace,
      key,
      value
    })
    review = await read()
  }
  return review
}

/** Use the same native project configuration/consent controls for trial and installed workspaces. */
export async function configureMutationProjectViaUi(input: {
  page: Page
  view: LocalProjectView
  knowledgeRoot: string
  additionalConfiguration?: Record<string, string | number>
  record(value: Record<string, unknown>): void
}) {
  const { page, view } = input
  const read = () =>
    page.evaluate(
      (id) => window.api.harnessBoard.localProjects.mods.read(id),
      view.project.projectId
    )
  let review = await saveMutationProjectConfigurationViaUi({
    ...input,
    values: {
      knowledgeRoot: input.knowledgeRoot,
      selectedDeployUnits: JSON.stringify([{ deployUnitId: "orders-api", appType: "backend" }]),
      ...input.additionalConfiguration
    }
  })
  const region = page.getByRole("region", { name: "本包功能权限", exact: true })
  for (let step = 0; step < 10; step++) {
    review = await read()
    const sources = [
      ...(review.source ? [{ source: review.source, dependency: false }] : []),
      ...(review.dependencies ?? []).map((source) => ({ source, dependency: true }))
    ]
    assert(
      sources.every(({ source }) => ["ready", "needs-approval"].includes(source.state)),
      `AUTOBIZ_CREATOR_PROVIDER_UNAVAILABLE:${JSON.stringify(review)}`
    )
    const pending = sources.find(
      ({ source }) =>
        !("configurationOnly" in source && source.configurationOnly) &&
        (source.state === "needs-approval" || review.workspaceEnabled === false)
    )
    if (!pending) break
    assert.notEqual(
      pending.source.configurationReady,
      false,
      "AUTOBIZ_CREATOR_PROVIDER_CONFIGURATION_REQUIRED"
    )
    const label =
      pending.source.state === "ready"
        ? "确认此版本并启用目录"
        : pending.dependency
          ? `允许依赖在当前目录运行：${pending.source.name}`
          : "允许本包在当前目录运行"
    const section = region.getByRole("region", {
      name: pending.dependency ? `依赖功能：${pending.source.name}` : "本包权限与参数",
      exact: true
    })
    await section.getByRole("button", { name: label, exact: true }).click()
    // Observe the persisted consent; an extra refresh click must not replay the approval.
    const deadline = Date.now() + 30000
    let approved = false
    while (!approved && Date.now() < deadline) {
      const actual = await read()
      const source = [actual.source, ...(actual.dependencies ?? [])].find(
        (item) => item?.pluginId === pending.source.pluginId
      )
      approved = source?.state === "ready" && actual.workspaceEnabled !== false
      if (!approved) await page.waitForTimeout(200)
    }
    assert(approved, "AUTOBIZ_CREATOR_NATIVE_CONSENT_NOT_READY")
  }
  review = await read()
  assert(
    !review.source ||
      (review.source.state === "ready" && review.source.configurationReady !== false)
  )
  assert(
    (review.dependencies ?? []).every(
      (source) => source.state === "ready" && source.configurationReady !== false
    )
  )
  assert.notEqual(review.workspaceEnabled, false)
  input.record({ type: "creator-project-native-consent-ready", review })
  return review
}
