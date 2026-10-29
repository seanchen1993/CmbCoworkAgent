import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { Page } from "playwright"
import type { LocalProjectView } from "../../src/shared/project-runtime/platform-api"
import type { HostProjectOperation } from "../../src/shared/project-runtime/host-types"
import {
  DELIVERY_DRAFT_TITLE,
  DELIVERY_POLICY,
  type CreatorDeliveryRuntimePhase,
  type creatorProjectDeliveryModel
} from "./creator-project-delivery-model"
import { KNOWLEDGE_MARKER, saveProjectKnowledge } from "./project-library-packaged-journey"
import { openUnifiedHostProject } from "./project-unified-native-journey"
import type { CreatorDeliveryCombination } from "./creator-delivery-combinations"

/** Runs only the exact package created by the native Creator conversion/install journey. */
export async function exerciseCreatorDeliveredProject(input: {
  page: Page
  created: LocalProjectView
  model: ReturnType<typeof creatorProjectDeliveryModel>
  retainedHookText: string
  artifacts: string
  restart: () => Promise<Page>
}) {
  let page = input.page
  const { created, model } = input
  const { projectId, workspace, name } = created.project
  const read = () => page.evaluate((id) => window.api.harnessBoard.localProjects.get(id), projectId)
  async function waitView(accept: (view: LocalProjectView) => boolean, label: string) {
    const end = Date.now() + 15000
    let latest = await read()
    while (!accept(latest) && Date.now() < end) {
      assert.deepEqual(model.errors, [])
      await new Promise((done) => setTimeout(done, 100))
      latest = await read()
    }
    assert(accept(latest), `${label}: ${JSON.stringify(latest)}`)
    return latest
  }
  const phases: Array<{
    phase: CreatorDeliveryRuntimePhase
    operation: HostProjectOperation
    elapsedMs: number
  }> = []
  async function run(phase: CreatorDeliveryRuntimePhase, expected: "failed" | "succeeded") {
    model.setRuntime(phase, workspace)
    const before = await read()
    const requestsBefore = model.requests.length
    const started = Date.now()
    await page.getByRole("button", { name: "开始当前阶段", exact: true }).click()
    await page.getByRole("button", { name: "批准并执行", exact: true }).waitFor()
    assert.equal(model.requests.length, requestsBefore, "Stage approval must precede inference")
    await page.getByRole("button", { name: "批准并执行", exact: true }).click()
    const approved = new Set<string>()
    let inspecting = false
    while (Date.now() - started < 90000) {
      assert.deepEqual(model.errors, [])
      const latest = await read()
      const operation = latest.operations[0]
      if (latest.operations.length <= before.operations.length) {
        await new Promise((done) => setTimeout(done, 100))
        continue
      }
      if (operation.status === expected) {
        assert(operation.execution?.threadId)
        assert.equal(operation.execution?.terminal?.outcome, "success")
        assert.equal(operation.stageId, phase === "review" ? "review" : "prepare")
        assert.equal(operation.approval?.decision, "approved")
        const rows = await page.evaluate(
          (id) => window.api.threads.getMessages(id),
          operation.execution.threadId
        )
        assert.equal(
          rows.filter(
            (row) =>
              row.role === "assistant" &&
              JSON.stringify(row.content).includes(`DELIVERY_RUNTIME_${phase.toUpperCase()}`)
          ).length,
          1,
          "The real SDK answer is persisted once"
        )
        phases.push({ phase, operation, elapsedMs: Date.now() - started })
        if (inspecting) await openUnifiedHostProject(page, name)
        return latest
      }
      assert(
        !["failed", "succeeded", "unknown", "cancelled"].includes(operation.status),
        `Unexpected stage result: ${JSON.stringify(operation)}`
      )
      if (operation.status === "started" && operation.execution?.threadId) {
        const pending = await page.evaluate(
          (id) => window.api.sandbox.getPendingApprovals(id),
          operation.execution.threadId
        )
        for (const value of pending) {
          const approval = value as { id: string; operation?: string; filePath?: string }
          assert(approval.id)
          assert.equal(approval.operation, "write_file")
          assert.equal(
            approval.filePath,
            join(workspace, phase === "review" ? "review.json" : "draft.json")
          )
          if (approved.has(approval.id)) continue
          if (!inspecting) {
            await page.getByRole("button", { name: "查看本次会话", exact: true }).first().click()
            inspecting = true
          }
          await page.getByText(`写入: ${approval.filePath}`, { exact: true }).waitFor()
          const current = await page.evaluate(
            (id) => window.api.sandbox.getPendingApprovals(id),
            operation.execution.threadId
          )
          assert.equal(current.length, 1)
          assert.deepEqual(current[0], value, "Approve the actual current native file request")
          await page.getByRole("button", { name: "允许", exact: true }).click()
          approved.add(approval.id)
        }
      }
      await new Promise((done) => setTimeout(done, 100))
    }
    throw Error(`Original 90s stage budget expired: ${phase}`)
  }
  const missing = await run("missing", "failed")
  assert(
    missing.operations[0].receipts.some(
      (receipt) => receipt.checkId === "draft-schema" && receipt.result !== "passed"
    )
  )
  assert.equal(missing.project.stageIndex, 0)
  assert.equal(await page.getByRole("button", { name: "进入下一阶段", exact: true }).count(), 0)
  const prepared = await run("prepare", "succeeded")
  assert(prepared.operations[0].receipts.every((receipt) => receipt.result === "passed"))
  const draft = readFileSync(join(workspace, "draft.json"), "utf8")
  assert.deepEqual(JSON.parse(draft), { title: DELIVERY_DRAFT_TITLE, policy: DELIVERY_POLICY })
  assert.equal(prepared.project.stageIndex, 0, "A passed check must not advance automatically")
  await saveProjectKnowledge(page)
  const libraryBefore = await page.evaluate(
    (id) => window.api.harnessBoard.localProjects.library.list(id),
    projectId
  )
  assert(libraryBefore.some((entry) => entry.note === KNOWLEDGE_MARKER))
  await page.getByRole("button", { name: "进入下一阶段", exact: true }).click()
  const advanced = await waitView((view) => view.project.stageIndex === 1, "Explicit stage advance")
  assert.equal(advanced.project.status, "active")
  const requestsBeforeRestart = model.requests.length
  const hooksBeforeRestart = model.hooks.length
  page = await input.restart()
  assert.deepEqual(
    await read(),
    advanced,
    "Whole-process restart preserves the exact stage boundary"
  )
  assert.deepEqual(
    await page.evaluate((id) => window.api.harnessBoard.localProjects.library.list(id), projectId),
    libraryBefore
  )
  assert.equal(model.requests.length, requestsBeforeRestart, "Restart cannot replay inference")
  assert.equal(model.hooks.length, hooksBeforeRestart, "Restart cannot replay retained Hooks")
  assert.equal(readFileSync(join(workspace, "draft.json"), "utf8"), draft)
  await openUnifiedHostProject(page, name)
  const reviewed = await run("review", "succeeded")
  assert.equal(reviewed.project.stageIndex, 1)
  assert(
    reviewed.operations[0].receipts.some(
      (receipt) => receipt.checkId === "draft-schema" && receipt.result === "passed"
    )
  )
  assert(
    reviewed.operations[0].receipts.some(
      (receipt) => receipt.checkId === "review-schema" && receipt.result === "passed"
    )
  )
  const review = readFileSync(join(workspace, "review.json"), "utf8")
  assert.deepEqual(JSON.parse(review), {
    checked: true,
    sourceTitle: JSON.parse(draft).title,
    policy: DELIVERY_POLICY,
    knowledge: KNOWLEDGE_MARKER
  })
  assert.equal(
    readFileSync(join(workspace, "draft.json"), "utf8"),
    draft,
    "The review consumes the original preceding artifact"
  )
  for (const { phase, operation } of phases) {
    for (const event of ["PreSkillUse", "PostSkillUse"]) {
      const hooks = model.hooks.filter((hook) => hook.phase === phase && hook.event === event)
      assert.equal(hooks.length, 1, `Exactly one retained ${event}/${phase}`)
      assert.equal(hooks[0].payload.session_id, operation.execution!.threadId)
      assert.equal(hooks[0].payload.plugin_id, created.project.installedPluginId)
      assert.equal(hooks[0].payload.plugin_name, created.project.packageId)
      const retainedHookPath = join(String(hooks[0].payload.plugin_root), "hooks/hooks.json")
      assert.equal(
        readFileSync(retainedHookPath, "utf8"),
        input.retainedHookText,
        "The executed Hook belongs to the preserved raw source package"
      )
    }
  }
  assert.equal(new Set(phases.map((entry) => entry.operation.execution!.threadId)).size, 3)
  await page.getByRole("button", { name: "确认完成任务", exact: true }).click()
  const completed = await waitView(
    (view) => view.project.status === "completed",
    "Explicit completion"
  )
  assert.equal(completed.project.pluginDigest, created.project.pluginDigest)
  await page.screenshot({ path: join(input.artifacts, "converted-project-completed.png") })
  return {
    completed,
    libraryBefore,
    phases,
    draft,
    review,
    requestsBeforeRestart,
    hooksBeforeRestart
  }
}

/** The same native runner for the pre-install trial and its installed ordinary project. */
export async function exerciseCreatorCombinationProject(input: {
  page: Page
  created: LocalProjectView
  model: ReturnType<typeof creatorProjectDeliveryModel>
  combination: CreatorDeliveryCombination
  retainedHookText: string
  artifacts: string
  trial: boolean
  restart: () => Promise<Page>
}) {
  let page = input.page
  const { created, model, combination } = input
  const { projectId, workspace, name } = created.project
  const hooksStart = model.hooks.length
  const read = () => page.evaluate((id) => window.api.harnessBoard.localProjects.get(id), projectId)
  async function waitNative<T>(
    readValue: () => Promise<T>,
    accept: (value: T) => boolean,
    label: string
  ) {
    const end = Date.now() + 15000
    let latest = await readValue()
    while (!accept(latest) && Date.now() < end) {
      assert.deepEqual(model.errors, [])
      await new Promise((done) => setTimeout(done, 100))
      latest = await readValue()
    }
    assert(accept(latest), `${label}: ${JSON.stringify(latest)}`)
    return latest
  }
  const observations: Array<{
    phase: CreatorDeliveryRuntimePhase
    operation: HostProjectOperation
  }> = []
  const outputs: Record<string, string> = {}
  const review = await page.evaluate(
    (id) => window.api.harnessBoard.localProjects.mods.read(id),
    projectId
  )
  assert.equal(review.source?.configurationOnly, true)
  assert.equal(
    review.source?.configurationReady,
    false,
    "A new workspace cannot inherit required configuration"
  )
  const requestsBeforeConfiguration = model.requests.length
  assert.equal(
    await page.getByRole("button", { name: "开始当前阶段", exact: true }).isDisabled(),
    true
  )
  assert.deepEqual((await read()).operations, [])
  const form = page.locator("[data-function-user-config]:visible")
  const field = form.getByLabel(/^业务标识/)
  await field.waitFor()
  assert.equal(await field.inputValue(), "")
  await field.fill(combination.configurationValue)
  await field.locator("xpath=../..").getByRole("button", { name: "保存", exact: true }).click()
  const configured = await waitNative(
    () =>
      page.evaluate(async (id) => {
        const actual = await window.api.harnessBoard.localProjects.mods.read(id)
        const values = await window.api.harnessBoard.localProjects.mods.config.userConfig(
          id,
          actual.source?.pluginId ?? "",
          actual.workspace
        )
        return { actual, values }
      }, projectId),
    (value) =>
      value.actual.source?.configurationReady === true &&
      value.values.fields.find((item) => item.key === "customer")?.value ===
        combination.configurationValue,
    "The explicit configuration save reaches native readback"
  )
  assert.equal(configured.actual.source?.configurationReady, true)
  assert.equal(
    configured.values.fields.find((item) => item.key === "customer")?.value,
    combination.configurationValue
  )
  assert.equal(
    model.requests.length,
    requestsBeforeConfiguration,
    "Configuration never starts inference"
  )
  async function run(
    phase: CreatorDeliveryRuntimePhase,
    index: number,
    expected: "failed" | "succeeded"
  ) {
    model.setRuntime(phase, workspace)
    const before = await read()
    const requests = model.requests.length
    await page.getByRole("button", { name: "开始当前阶段", exact: true }).click()
    await page.getByRole("button", { name: "批准并执行", exact: true }).waitFor()
    assert.equal(
      model.requests.length,
      requests,
      "The original stage approval still gates inference"
    )
    await page.getByRole("button", { name: "批准并执行", exact: true }).click()
    const approved = new Set<string>()
    const deadline = Date.now() + 90000
    let inspecting = false
    while (Date.now() < deadline) {
      assert.deepEqual(model.errors, [])
      const current = await read(),
        operation = current.operations[0]
      if (current.operations.length > before.operations.length) {
        if (operation.status === expected) {
          assert.equal(operation.execution?.terminal?.outcome, "success")
          assert.equal(operation.stageId, combination.stages[index].id)
          assert.equal(operation.approval?.decision, "approved")
          const transcript = await page.evaluate(
            (id) => window.api.threads.getMessages(id),
            operation.execution!.threadId
          )
          assert.equal(
            transcript.filter(
              (message) =>
                message.role === "assistant" &&
                JSON.stringify(message.content).includes(`DELIVERY_RUNTIME_${phase.toUpperCase()}`)
            ).length,
            1
          )
          observations.push({ phase, operation })
          if (inspecting) await openUnifiedHostProject(page, name)
          return current
        }
        assert(
          !["failed", "succeeded", "unknown", "cancelled"].includes(operation.status),
          `Unexpected real combination stage result: ${JSON.stringify(operation)}`
        )
        if (operation.status === "started" && operation.execution?.threadId) {
          const pending = await page.evaluate(
            (id) => window.api.sandbox.getPendingApprovals(id),
            operation.execution.threadId
          )
          for (const value of pending) {
            const actual = value as { id: string; operation: string; filePath: string }
            assert.equal(actual.operation, "write_file")
            assert.equal(actual.filePath, join(workspace, combination.stages[index].path))
            if (approved.has(actual.id)) continue
            if (!inspecting) {
              await page.getByRole("button", { name: "查看本次会话", exact: true }).first().click()
              inspecting = true
            }
            await page.getByText(`写入: ${actual.filePath}`, { exact: true }).waitFor()
            assert.deepEqual(
              await page.evaluate(
                (id) => window.api.sandbox.getPendingApprovals(id),
                operation.execution.threadId
              ),
              [value]
            )
            await page.getByRole("button", { name: "允许", exact: true }).click()
            approved.add(actual.id)
          }
        }
      }
      await new Promise((done) => setTimeout(done, 100))
    }
    throw Error(`Original 90s stage budget expired: ${combination.id}/${phase}`)
  }
  const missing = await run("missing", 0, "failed")
  assert(missing.operations[0].receipts.some((receipt) => receipt.result !== "passed"))
  assert.equal(missing.project.stageIndex, 0)
  assert.equal(await page.getByRole("button", { name: "进入下一阶段", exact: true }).count(), 0)
  let library: Awaited<ReturnType<typeof window.api.harnessBoard.localProjects.library.list>> = []
  for (const [index, stage] of combination.stages.entries()) {
    const passed = await run(stage.id as CreatorDeliveryRuntimePhase, index, "succeeded")
    assert.equal(
      passed.project.stageIndex,
      index,
      "Passing checks cannot silently advance the stage"
    )
    assert(passed.operations[0].receipts.every((receipt) => receipt.result === "passed"))
    const content = readFileSync(join(workspace, stage.path), "utf8")
    assert.deepEqual(JSON.parse(content), combination.output(index))
    outputs[stage.path] = content
    for (const [path, previous] of Object.entries(outputs))
      assert.equal(readFileSync(join(workspace, path), "utf8"), previous)
    if (index === 0) {
      await saveProjectKnowledge(page)
      library = await page.evaluate(
        (id) => window.api.harnessBoard.localProjects.library.list(id),
        projectId
      )
      assert(library.some((entry) => entry.note === KNOWLEDGE_MARKER))
    }
    if (index < combination.stages.length - 1) {
      await page.getByRole("button", { name: "进入下一阶段", exact: true }).click()
      const advanced = await waitNative(
        read,
        (value) => value.project.stageIndex === index + 1,
        "Explicit stage advance"
      )
      assert.equal(advanced.project.stageIndex, index + 1)
      if (index === 0 && !input.trial) {
        const requests = model.requests.length,
          hooks = model.hooks.length
        page = await input.restart()
        assert.deepEqual(await read(), advanced)
        assert.equal(model.requests.length, requests)
        assert.equal(model.hooks.length, hooks)
        assert.deepEqual(
          await page.evaluate(
            (id) => window.api.harnessBoard.localProjects.library.list(id),
            projectId
          ),
          library
        )
        const values = await page.evaluate(
          ({ id, pluginId, workspace }) =>
            window.api.harnessBoard.localProjects.mods.config.userConfig(id, pluginId, workspace),
          {
            id: projectId,
            pluginId: configured.actual.source?.pluginId ?? "",
            workspace: configured.actual.workspace
          }
        )
        assert.deepEqual(
          values,
          configured.values,
          "Restart preserves the actual native required configuration"
        )
        await openUnifiedHostProject(page, name)
      }
    }
  }
  for (const { phase, operation } of observations)
    for (const event of ["PreSkillUse", "PostSkillUse"]) {
      const hooks = model.hooks
        .slice(hooksStart)
        .filter((hook) => hook.phase === phase && hook.event === event)
      assert.equal(hooks.length, 1)
      assert.equal(hooks[0].payload.session_id, operation.execution!.threadId)
      assert.equal(hooks[0].payload.plugin_id, created.project.installedPluginId)
      assert.equal(
        readFileSync(join(String(hooks[0].payload.plugin_root), "hooks/hooks.json"), "utf8"),
        input.retainedHookText
      )
    }
  assert.equal(
    new Set(observations.map((item) => item.operation.execution!.threadId)).size,
    combination.stages.length + 1
  )
  await page.getByRole("button", { name: "确认完成任务", exact: true }).click()
  const completed = await waitNative(
    read,
    (value) => value.project.status === "completed",
    "Explicit project completion"
  )
  assert.equal(completed.project.status, "completed")
  assert.equal(completed.project.pluginDigest, created.project.pluginDigest)
  await page.screenshot({
    path: join(
      input.artifacts,
      `${input.trial ? "trial" : "ordinary"}-${combination.id}-completed.png`
    )
  })
  return { completed, outputs, observations, configured, library, combination: combination.id }
}
