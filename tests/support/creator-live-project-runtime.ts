/** Executes the unchanged, freely authored candidate through public native UI and APIs. */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import type { ElectronApplication, Page } from "playwright"
import type { LocalProjectView } from "../../src/shared/project-runtime/platform-api"
import { normalizeWorkspacePathKey } from "../../src/shared/workspace-path"
import { openCreatorProjectPreview, openCreatorStep } from "./creator-navigation"
import { openUnifiedProjectList } from "./project-unified-native-journey"
import { liveProjectDeliveryName } from "./live-project-delivery-name"
import { reimportLiveProjectZip } from "./live-project-zip-reimport"
import { exerciseLiveOriginalFeatureJourney } from "./live-original-feature-journey"

export async function exerciseLiveGeneratedProject(input: {
  app: ElectronApplication
  page: Page
  authorThreadId: string
  authorWorkspace: string
  artifacts: string
  artifactPrefix?: string
  /** Explicitly continue this same installed project; never select another project by name. */
  installedProjectId?: string
  goal?: string
  approvedCommand?(command: string, workspace: string): boolean | Promise<boolean>
  deadline: number
  beginStage(label: string, workspace: string, projectId: string): void
  endStage(): void
}) {
  const { page, authorThreadId, authorWorkspace, deadline } = input
  const projectWorkspaces = new Map<string, string>()
  async function openUnifiedHostProject(page: Page, name: string) {
    await openUnifiedProjectList(page)
    const workspace = projectWorkspaces.get(name)
    assert(workspace, "LIVE_PROJECT_EXPECTED_WORKSPACE_REQUIRED")
    const records = await page.evaluate(() => window.api.harnessBoard.localProjects.list())
    const matches = records.filter(
      (record) =>
        record.name === name &&
        normalizeWorkspacePathKey(record.workspace) === normalizeWorkspacePathKey(workspace)
    )
    assert.equal(matches.length, 1, "LIVE_PROJECT_EXACT_PERSISTED_TRIAL_REQUIRED")
    // Isolated Host trials are intentionally separate from the original Feature project list.
    const history = page
      .locator("details")
      .filter({ has: page.getByText("历史独立运行（兼容查看）", { exact: true }) })
    assert.equal(await history.count(), 1, "LIVE_PROJECT_HISTORY_SECTION_REQUIRED")
    if (!(await history.evaluate((node) => (node as HTMLDetailsElement).open)))
      await history.locator(":scope > summary").click()
    await page
      .getByRole("button", { name: `打开项目 ${name}`, exact: true })
      .filter({ has: page.getByText(workspace, { exact: true }) })
      .click()
    await page
      .getByRole("heading", {
        name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} ·`)
      })
      .waitFor()
  }
  const creator = page.getByRole("dialog", { name: "插件创作工作区", exact: true })
  const artifactRoot = realpathSync(input.artifacts)
  const artifactPrefix = input.artifactPrefix ?? "live-project"
  assert(/^[A-Za-z0-9_.-]{1,100}$/.test(artifactPrefix), "LIVE_ARTIFACT_PREFIX_INVALID")
  const events: Array<Record<string, unknown>> = []
  let reviewedCommand:
    | { id: string; command: string; workspace: string; digest: string; uiApproved: boolean }
    | undefined
  const reviewedCommands: NonNullable<typeof reviewedCommand>[] = []
  const save = () =>
    writeFileSync(
      join(input.artifacts, `${artifactPrefix}-runtime.json`),
      JSON.stringify({ model: "real configured provider; no fixture outputs", events }, null, 2)
    )
  const remaining = (end = deadline) => {
    const value = Math.min(deadline, end) - Date.now()
    assert(value > 0, "LIVE_PROJECT_TIME_LIMIT")
    return Math.min(value, 15000)
  }
  async function until<T>(
    read: () => Promise<T>,
    accept: (value: T) => boolean,
    code: string,
    end = deadline
  ) {
    do {
      remaining(end)
      const value = await read()
      if (accept(value)) return value
      await new Promise((done) => setTimeout(done, 100))
    } while (Date.now() < Math.min(end, deadline))
    throw Error(code)
  }
  function inside(root: string, target: string) {
    const path = relative(root, target)
    assert(
      !isAbsolute(path) && path !== ".." && !path.startsWith(`..\\`) && !path.startsWith("../"),
      "LIVE_PROJECT_PATH_OUTSIDE_PRIVATE_WORKSPACE"
    )
  }
  function privatePath(workspace: string, path: string) {
    assert(isAbsolute(path) && !path.includes("\0"), "LIVE_PROJECT_APPROVAL_PATH_INVALID")
    const target = resolve(path)
    inside(workspace, target)
    let ancestor = target
    while (!existsSync(ancestor)) {
      const parent = dirname(ancestor)
      assert.notEqual(parent, ancestor, "LIVE_PROJECT_APPROVAL_ANCESTOR_INVALID")
      ancestor = parent
    }
    inside(realpathSync(workspace), realpathSync(ancestor))
    return target
  }
  const metadata = (view: LocalProjectView) => ({
    projectId: view.project.projectId,
    pluginId: view.project.installedPluginId,
    pluginDigest: view.project.pluginDigest,
    packageId: view.project.packageId,
    packageVersion: view.project.packageVersion,
    status: view.project.status,
    stageIndex: view.project.stageIndex,
    stages: view.project.manifest.stages.map((stage) => stage.id)
  })
  const status = () =>
    page.evaluate((threadId) => window.api.mods.development.status({ threadId }), authorThreadId)
  const authored = await status()
  assert.equal(
    normalizeWorkspacePathKey(authored.workspace),
    normalizeWorkspacePathKey(authorWorkspace),
    "LIVE_PROJECT_AUTHOR_SCOPE_CHANGED"
  )
  const request = authored.projectTrial!
  assert(request, "LIVE_PROJECT_CANDIDATE_REQUIRED")
  const author = await page.evaluate((id) => window.api.threads.get(id), authorThreadId)
  assert(author?.title, "LIVE_PROJECT_AUTHOR_TITLE_REQUIRED")

  async function runProject(created: LocalProjectView, kind: "trial") {
    const { projectId, workspace, name, manifest } = created.project
    projectWorkspaces.set(name, workspace)
    inside(artifactRoot, realpathSync(workspace))
    assert.equal(manifest.mode, "host", "LIVE_PROJECT_HOST_REQUIRED")
    assert.equal(manifest.actions.length, 0, "LIVE_PROJECT_EXTERNAL_ACTION_FORBIDDEN")
    assert(
      manifest.checks.every(
        (check) =>
          check.sideEffect === "read" && ["file-exists", "json-schema"].includes(check.kind)
      ),
      "LIVE_PROJECT_NONLOCAL_CHECK_FORBIDDEN"
    )
    const read = () =>
      page.evaluate((id) => window.api.harnessBoard.localProjects.get(id), projectId)
    const approvals = new Set<string>()
    const deniedApprovals = new Set<string>()
    const sessions = new Set<string>()
    for (const [index, stage] of manifest.stages.entries()) {
      const current = await read()
      if (current.project.status === "completed" || index < current.project.stageIndex) {
        assert(
          current.operations.some(
            (operation) =>
              operation.stageId === stage.id &&
              operation.status === "transitioned" &&
              operation.receipts.length > 0 &&
              operation.receipts.every((receipt) => receipt.result === "passed")
          ),
          "LIVE_PROJECT_RETAINED_STAGE_NOT_VERIFIED"
        )
        events.push({ kind, stageId: stage.id, retained: "transitioned" })
        continue
      }
      const stageEnd = Math.min(deadline, Date.now() + 90000)
      input.beginStage(`${kind}/${index + 1}:${stage.id}`, workspace, projectId)
      try {
        let before = await read()
        assert.equal(before.project.stageIndex, index, "LIVE_PROJECT_STAGE_POSITION_CHANGED")
        assert.equal(before.project.status, "active", "LIVE_PROJECT_ALREADY_COMPLETED")
        const liveOperation = (view: LocalProjectView) =>
          view.operations.find(
            (operation) =>
              operation.expectedVersion === view.project.version &&
              operation.stageId === stage.id &&
              ["prepared", "started", "cancel_requested", "succeeded", "unknown"].includes(
                operation.status
              )
          )
        let retained = liveOperation(before)
        if (retained && ["started", "cancel_requested"].includes(retained.status)) {
          // A prior caller may have closed during execution. Stop through its original owner,
          // then inspect the saved result; never substitute a new operation for an unknown one.
          if (retained.status === "started")
            await page
              .getByRole("button", { name: "停止本次步骤", exact: true })
              .click({ timeout: remaining(stageEnd) })
          before = await until(
            read,
            (view) =>
              !["started", "cancel_requested"].includes(
                view.operations.find((operation) => operation.operationId === retained!.operationId)
                  ?.status ?? ""
              ),
            "LIVE_PROJECT_PREVIOUS_EXECUTION_UNSETTLED",
            stageEnd
          )
          retained = liveOperation(before)
        }
        if (retained?.status === "unknown") {
          const uncertain = retained
          await page
            .getByRole("button", { name: "核对上次执行结果", exact: true })
            .click({ timeout: remaining(stageEnd) })
          before = await until(
            read,
            (view) => {
              const operation = view.operations.find(
                (value) => value.operationId === uncertain.operationId
              )
              return Boolean(
                operation &&
                (operation.status !== "unknown" || operation.updatedAt > uncertain.updatedAt)
              )
            },
            "LIVE_PROJECT_NATIVE_RECONCILIATION_TIMEOUT",
            stageEnd
          )
          const reconciled = before.operations.find(
            (value) => value.operationId === uncertain.operationId
          )!
          events.push({
            kind,
            stageId: stage.id,
            recoveryOperationId: uncertain.operationId,
            nativeReconciledStatus: reconciled.status,
            terminalOutcome: reconciled.execution?.terminal?.outcome
          })
          save()
          assert.notEqual(reconciled.status, "unknown", "LIVE_PROJECT_RECOVERY_REMAINS_UNKNOWN")
          assert(
            ["failed", "cancelled", "succeeded"].includes(reconciled.status),
            "LIVE_PROJECT_RECOVERY_RESULT_UNEXPECTED"
          )
          retained = liveOperation(before)
        }
        let prepared = before
        if (!retained) {
          if (input.goal && before.project.goal !== input.goal) {
            const summary = page.getByText("补充要求（可选）", { exact: true })
            assert(await summary.isVisible(), "LIVE_PROJECT_GOAL_REVIEW_REQUIRED")
            if (
              !(await summary.evaluate(
                (element) => (element.parentElement as HTMLDetailsElement).open
              ))
            )
              await summary.click({ timeout: remaining(stageEnd) })
            await page
              .getByRole("textbox", { name: "本次阶段补充说明（可选）", exact: true })
              .fill(input.goal, { timeout: remaining(stageEnd) })
            events.push({
              kind,
              stageId: stage.id,
              supplementalInput: "public synthetic business requirement",
              bytes: Buffer.byteLength(input.goal),
              sha256: createHash("sha256").update(input.goal).digest("hex")
            })
          }
          await page
            .getByRole("button", { name: "开始当前阶段", exact: true })
            .click({ timeout: remaining(stageEnd) })
          prepared = await until(
            read,
            (view) => view.operations.length > before.operations.length,
            "LIVE_PROJECT_PREPARE_TIMEOUT",
            stageEnd
          )
          retained = prepared.operations.find(
            (operation) =>
              !before.operations.some((previous) => previous.operationId === operation.operationId)
          )
        }
        assert(retained, "LIVE_PROJECT_CURRENT_OPERATION_REQUIRED")
        assert(
          !["failed", "unknown", "cancelled", "cancel_requested", "transitioned"].includes(
            retained.status
          ),
          `LIVE_PROJECT_STAGE_${retained.status.toUpperCase()}`
        )
        assert(!retained.contextProvider, "LIVE_PROJECT_EXTERNAL_CONTEXT_FORBIDDEN")
        const operationId = retained.operationId
        if (stage.approval === "human" && retained.status !== "succeeded") {
          assert.equal(retained.status, "prepared", "LIVE_PROJECT_INFERENCE_BEFORE_CONFIRMATION")
          await page
            .getByRole("button", {
              name: retained.approval?.decision === "approved" ? "继续执行" : "批准并执行",
              exact: true
            })
            .click({ timeout: remaining(stageEnd) })
        } else if (stage.approval !== "human") {
          // The native start action itself executes automatic stages. A prepared snapshot
          // may be observed briefly before its start completes; do not click a second start.
          assert(
            ["prepared", "started", "succeeded"].includes(retained.status),
            "LIVE_PROJECT_AUTOMATIC_START_UNEXPECTED"
          )
        }
        let inspecting = false
        let succeeded: LocalProjectView | undefined
        while (Date.now() < stageEnd) {
          remaining(stageEnd)
          const view = await read()
          const operation = view.operations.find((value) => value.operationId === operationId)
          assert(operation, "LIVE_PROJECT_OPERATION_DISAPPEARED")
          assert.equal(operation.stageId, stage.id, "LIVE_PROJECT_STAGE_SCOPE_CHANGED")
          assert.equal(
            operation.pluginDigest,
            created.project.pluginDigest,
            "LIVE_PROJECT_SOURCE_CHANGED"
          )
          assert(!view.inputWait, "LIVE_PROJECT_UNEXPECTED_INPUT_REQUIRED")
          if (operation.status === "succeeded") {
            assert.equal(
              operation.execution?.terminal?.outcome,
              "success",
              "LIVE_PROJECT_MODEL_TERMINAL_FAILED"
            )
            assert(
              operation.receipts.length > 0 &&
                operation.receipts.every((receipt) => receipt.result === "passed"),
              "LIVE_PROJECT_CHECKS_NOT_PASSED"
            )
            assert(operation.execution?.threadId, "LIVE_PROJECT_EXECUTION_THREAD_REQUIRED")
            assert(!sessions.has(operation.execution.threadId), "LIVE_PROJECT_STAGE_SESSION_REUSED")
            sessions.add(operation.execution.threadId)
            if (stage.approval === "human")
              assert.equal(
                operation.approval?.decision,
                "approved",
                "LIVE_PROJECT_STAGE_APPROVAL_REQUIRED"
              )
            events.push({
              kind,
              stageId: stage.id,
              operationId,
              threadId: operation.execution.threadId,
              status: operation.status,
              checks: operation.receipts.map((receipt) => ({
                id: receipt.checkId,
                result: receipt.result
              }))
            })
            succeeded = view
            if (inspecting) await openUnifiedHostProject(page, name)
            break
          }
          if (["failed", "unknown", "cancelled", "cancel_requested"].includes(operation.status)) {
            events.push({
              kind,
              stageId: stage.id,
              event: "native-stage-terminal",
              operationId: operation.operationId,
              status: operation.status,
              terminal: operation.execution?.terminal
                ? {
                    outcome: operation.execution.terminal.outcome,
                    code: operation.execution.terminal.code
                  }
                : null
            })
            save()
          }
          assert(
            !["failed", "unknown", "cancelled", "cancel_requested", "transitioned"].includes(
              operation.status
            ),
            `LIVE_PROJECT_STAGE_${operation.status.toUpperCase()}`
          )
          if (operation.execution?.threadId) {
            const pending = await page.evaluate(
              (id) => window.api.sandbox.getPendingApprovals(id),
              operation.execution.threadId
            )
            type RuntimeApproval = {
              id?: string
              operation?: string
              filePath?: string
              command?: string
              cwd?: string
              retry_reason?: string
              _retryReason?: string
            }
            const validateApproval = (value: unknown) => {
              const approval = value as RuntimeApproval
              if (approval.operation === "execute") {
                assert(
                  approval.id &&
                    typeof approval.command === "string" &&
                    approval.command.length > 0 &&
                    typeof approval.cwd === "string",
                  "LIVE_PROJECT_COMMAND_APPROVAL_INVALID"
                )
                assert.equal(
                  normalizeWorkspacePathKey(approval.cwd),
                  normalizeWorkspacePathKey(workspace),
                  "LIVE_PROJECT_COMMAND_WORKSPACE_CHANGED"
                )
                assert(
                  !approval.retry_reason && !approval._retryReason,
                  "LIVE_PROJECT_UNSANDBOXED_RETRY_FORBIDDEN"
                )
                const reviewed = reviewedCommands.find((entry) => entry.id === approval.id)
                if (reviewed)
                  assert(
                    reviewed.command === approval.command && reviewed.workspace === workspace,
                    "LIVE_PROJECT_COMMAND_IDENTITY_CHANGED"
                  )
                return
              }
              assert(approval.id && approval.filePath, "LIVE_PROJECT_NONFILE_APPROVAL_FORBIDDEN")
              assert(
                ["read_file", "write_file", "edit_file", "ls", "list_directory"].includes(
                  approval.operation ?? ""
                ),
                "LIVE_PROJECT_COMMAND_OR_EXTERNAL_APPROVAL_FORBIDDEN"
              )
              privatePath(workspace, approval.filePath)
            }
            pending.forEach(validateApproval)
            assert(
              pending.filter((value) => (value as RuntimeApproval).operation === "execute")
                .length <= 1,
              "LIVE_PROJECT_MULTIPLE_COMMANDS_REQUIRE_REVIEW"
            )
            for (const value of pending) {
              const approval = value as RuntimeApproval
              assert(approval.id, "LIVE_PROJECT_APPROVAL_ID_REQUIRED")
              if (approvals.has(approval.id)) continue
              const command = approval.operation === "execute"
              let commandAccepted = true
              if (command && reviewedCommand?.id !== approval.id) {
                assert(approval.command, "LIVE_PROJECT_COMMAND_REVIEW_REQUIRED")
                let timer: ReturnType<typeof setTimeout> | undefined
                let accepted = false
                try {
                  accepted = await Promise.race([
                    Promise.resolve(input.approvedCommand?.(approval.command, workspace) ?? false),
                    new Promise<never>((_done, reject) => {
                      timer = setTimeout(
                        () => reject(Error("LIVE_PROJECT_COMMAND_REVIEW_TIME_LIMIT")),
                        Math.max(1, Math.min(deadline, stageEnd) - Date.now())
                      )
                    })
                  ])
                } finally {
                  clearTimeout(timer)
                }
                remaining(stageEnd)
                commandAccepted = accepted
                if (accepted) {
                  reviewedCommand = {
                    id: approval.id,
                    command: approval.command,
                    workspace,
                    digest: createHash("sha256")
                      .update(JSON.stringify({ command: approval.command, workspace }))
                      .digest("hex"),
                    uiApproved: false
                  }
                  reviewedCommands.push(reviewedCommand)
                }
              }
              if (!inspecting) {
                await page
                  .getByRole("button", { name: "查看本次会话", exact: true })
                  .first()
                  .click({ timeout: remaining(stageEnd) })
                inspecting = true
              }
              const label = approval.operation === "write_file" ? "写入" : "编辑"
              await page
                .getByText(command ? approval.command! : `${label}: ${approval.filePath}`, {
                  exact: true
                })
                .waitFor({ timeout: remaining(stageEnd) })
              const currentApprovals = await page.evaluate(
                (id) => window.api.sandbox.getPendingApprovals(id),
                operation.execution.threadId
              )
              currentApprovals.forEach(validateApproval)
              assert(
                currentApprovals.filter(
                  (entry) => (entry as RuntimeApproval).operation === "execute"
                ).length <= 1,
                "LIVE_PROJECT_MULTIPLE_COMMANDS_REQUIRE_REVIEW"
              )
              assert.deepEqual(
                currentApprovals.find((current) => (current as { id?: string }).id === approval.id),
                value,
                "LIVE_PROJECT_APPROVAL_IDENTITY_CHANGED"
              )
              if (command) {
                const current = await read()
                assert.equal(
                  current.project.projectId,
                  projectId,
                  "LIVE_PROJECT_COMMAND_PROJECT_CHANGED"
                )
                assert.equal(
                  normalizeWorkspacePathKey(current.project.workspace),
                  normalizeWorkspacePathKey(workspace),
                  "LIVE_PROJECT_COMMAND_WORKSPACE_CHANGED"
                )
                assert.equal(
                  current.project.pluginDigest,
                  created.project.pluginDigest,
                  "LIVE_PROJECT_SOURCE_CHANGED"
                )
                assert.equal(
                  current.operations.find((entry) => entry.operationId === operationId)?.execution
                    ?.threadId,
                  operation.execution.threadId,
                  "LIVE_PROJECT_COMMAND_THREAD_CHANGED"
                )
                if (!commandAccepted) {
                  const chat = page.locator(
                    `[data-chat-thread-id=${JSON.stringify(operation.execution.threadId)}]`
                  )
                  const box = chat.locator("div.max-w-3xl.border-2").filter({
                    has: page.getByText(approval.command!, { exact: true })
                  })
                  assert.equal(await box.count(), 1, "LIVE_PROJECT_REJECTION_UI_AMBIGUOUS")
                  await box.getByRole("button", { name: "拒绝", exact: true }).click({
                    timeout: remaining(stageEnd)
                  })
                  await until(
                    () =>
                      page.evaluate(
                        (id) => window.api.sandbox.getPendingApprovals(id),
                        operation.execution!.threadId
                      ),
                    (values) =>
                      !values.some((entry) => (entry as RuntimeApproval).id === approval.id),
                    "LIVE_PROJECT_COMMAND_REJECTION_NOT_ACKNOWLEDGED",
                    stageEnd
                  )
                  approvals.add(approval.id)
                  deniedApprovals.add(approval.id)
                  events.push({
                    kind,
                    stageId: stage.id,
                    approvalId: approval.id,
                    operation: "execute",
                    event: "native-ui-rejected",
                    command: approval.command,
                    workspace
                  })
                  save()
                  continue
                }
                assert(
                  reviewedCommand &&
                    reviewedCommand.id === approval.id &&
                    reviewedCommand.command === approval.command &&
                    reviewedCommand.workspace === workspace,
                  "LIVE_PROJECT_COMMAND_IDENTITY_CHANGED"
                )
                events.push({
                  kind,
                  stageId: stage.id,
                  approvalId: approval.id,
                  operation: "execute",
                  command: reviewedCommand.command,
                  workspace,
                  digest: reviewedCommand.digest,
                  threadId: operation.execution.threadId,
                  projectId,
                  event: "reviewed-before-native-ui"
                })
                save()
              }
              await page
                .getByRole("button", { name: command ? "运行" : "允许", exact: true })
                .click({ timeout: remaining(stageEnd) })
              await until(
                () =>
                  page.evaluate(
                    (id) => window.api.sandbox.getPendingApprovals(id),
                    operation.execution!.threadId
                  ),
                (current) =>
                  !current.some((entry) => (entry as { id?: string }).id === approval.id),
                "LIVE_PROJECT_APPROVAL_DECISION_NOT_APPLIED",
                stageEnd
              )
              approvals.add(approval.id)
              if (command && reviewedCommand) reviewedCommand.uiApproved = true
              events.push({
                kind,
                stageId: stage.id,
                approvalId: approval.id,
                operation: approval.operation,
                ...(command
                  ? {
                      command: reviewedCommand!.command,
                      workspace,
                      digest: reviewedCommand!.digest,
                      threadId: operation.execution.threadId,
                      projectId,
                      event: "native-ui-approved"
                    }
                  : { filePath: approval.filePath })
              })
              save()
              // Re-read both the native queue and visible current card before the next request.
              break
            }
          }
          await new Promise((done) => setTimeout(done, 100))
        }
        assert(succeeded, "LIVE_PROJECT_STAGE_TIME_LIMIT")
        assert.equal(
          succeeded.project.stageIndex,
          index,
          "LIVE_PROJECT_AUTOMATIC_ADVANCE_FORBIDDEN"
        )
        if (succeeded.resultApprovalRequired) {
          assert(
            succeeded.resultReview && !succeeded.resultReviewError,
            "LIVE_PROJECT_RESULT_REVIEW_REQUIRED"
          )
          await page
            .getByRole("button", { name: "接受当前成果", exact: true })
            .click({ timeout: remaining(stageEnd) })
          await until(
            read,
            (view) =>
              view.operations.find((value) => value.operationId === operationId)?.resultApproval
                ?.decision === "approved",
            "LIVE_PROJECT_RESULT_CONFIRMATION_TIMEOUT",
            stageEnd
          )
        }
        await page
          .getByRole("button", {
            name: index + 1 < manifest.stages.length ? "进入下一阶段" : "确认完成任务",
            exact: true
          })
          .click({ timeout: remaining(stageEnd) })
        const advanced = await until(
          read,
          (view) =>
            index + 1 < manifest.stages.length
              ? view.project.stageIndex === index + 1
              : view.project.status === "completed",
          "LIVE_PROJECT_TRANSITION_TIMEOUT",
          stageEnd
        )
        assert.equal(
          advanced.project.pluginDigest,
          created.project.pluginDigest,
          "LIVE_PROJECT_SOURCE_CHANGED"
        )
        save()
      } catch (error) {
        // The execution/HTTP budget has already ended on timeout. Cleanup never starts
        // another model turn; its only mutation is the original owner's visible Stop.
        let cleaningOperationId: string | undefined
        try {
          let current = await read()
          const running = current.operations.find(
            (operation) =>
              operation.stageId === stage.id &&
              operation.expectedVersion === current.project.version &&
              ["started", "cancel_requested", "unknown"].includes(operation.status)
          )
          if (running?.status === "unknown") {
            events.push({
              kind,
              stageId: stage.id,
              event: "failure-kept-unknown",
              operationId: running.operationId,
              threadId: running.execution?.threadId,
              terminalOutcome: running.execution?.terminal?.outcome,
              terminalCode: running.execution?.terminal?.code
            })
            save()
          } else if (running) {
            cleaningOperationId = running.operationId
            await openUnifiedHostProject(page, name)
            current = await read()
            const original = current.operations.find(
              (operation) => operation.operationId === running.operationId
            )
            assert(original, "LIVE_PROJECT_CLEANUP_OPERATION_DISAPPEARED")
            assert.equal(
              current.project.projectId,
              projectId,
              "LIVE_PROJECT_CLEANUP_PROJECT_CHANGED"
            )
            assert.equal(
              current.project.pluginDigest,
              created.project.pluginDigest,
              "LIVE_PROJECT_CLEANUP_SOURCE_CHANGED"
            )
            if (original.status === "started")
              await page
                .getByRole("button", { name: "停止本次步骤", exact: true })
                .click({ timeout: 5000 })
            const cleanupDeadline = Date.now() + 15000
            let acknowledged = false
            do {
              current = await read()
              const operation = current.operations.find(
                (value) => value.operationId === running.operationId
              )
              assert(operation, "LIVE_PROJECT_CLEANUP_OPERATION_DISAPPEARED")
              if (!["started", "cancel_requested"].includes(operation.status)) {
                events.push({
                  kind,
                  stageId: stage.id,
                  event:
                    operation.status === "unknown"
                      ? "failure-stop-remains-unknown"
                      : "failure-native-stop-settled",
                  operationId: operation.operationId,
                  threadId: operation.execution?.threadId,
                  status: operation.status,
                  terminalOutcome: operation.execution?.terminal?.outcome,
                  terminalCode: operation.execution?.terminal?.code,
                  terminalSettledAt: operation.execution?.terminal?.settledAt
                })
                acknowledged = true
                save()
                break
              }
              await new Promise((done) => setTimeout(done, 100))
            } while (Date.now() < cleanupDeadline)
            if (!acknowledged) {
              events.push({
                kind,
                stageId: stage.id,
                event: "failure-native-stop-unsettled",
                operationId: running.operationId,
                status: current.operations.find(
                  (operation) => operation.operationId === running.operationId
                )?.status
              })
              save()
            }
          }
        } catch (cleanupError) {
          events.push({
            kind,
            stageId: stage.id,
            event: "failure-native-stop-unconfirmed",
            operationId: cleaningOperationId,
            code:
              (cleanupError instanceof Error ? cleanupError.message : "").match(
                /\b[A-Z][A-Z0-9_]{3,100}\b/
              )?.[0] ?? "LIVE_PROJECT_CLEANUP_FAILED"
          })
          save()
        }
        throw error
      } finally {
        input.endStage()
      }
    }
    const completed = await read()
    assert.equal(completed.project.status, "completed", "LIVE_PROJECT_NOT_COMPLETED")
    const artifacts = manifest.artifacts.flatMap((artifact) => {
      const path = privatePath(workspace, resolve(workspace, artifact.path))
      assert(!artifact.required || existsSync(path), "LIVE_PROJECT_REQUIRED_ARTIFACT_MISSING")
      if (!existsSync(path)) return []
      assert(statSync(path).isFile(), "LIVE_PROJECT_ARTIFACT_NOT_FILE")
      const bytes = readFileSync(path)
      return [
        {
          id: artifact.id,
          path: artifact.path,
          bytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex")
        }
      ]
    })
    await page.screenshot({
      path: join(input.artifacts, `${artifactPrefix}-${kind}-completed.png`)
    })
    return {
      ...metadata(completed),
      artifacts,
      approvals: approvals.size - deniedApprovals.size,
      deniedApprovals: deniedApprovals.size,
      sessions: sessions.size
    }
  }

  assert(!input.installedProjectId, "LIVE_LEGACY_HOST_CONTINUATION_REQUIRES_FRESH_ORIGINAL_FEATURE")
  let projectId: string
  if (request.journey?.phase === "passed" && request.journey.canDeliver) {
    assert.equal(
      request.journey.candidateDigest,
      request.digest,
      "LIVE_RETAINED_TRIAL_SOURCE_CHANGED"
    )
    projectId = request.journey.projectId
  } else {
    const panel = await openCreatorProjectPreview(page)
    const previews = () =>
      page.evaluate((id) => window.api.harnessBoard.localProjects.preview.list(id), authorThreadId)
    const initialPreview = await previews()
    const currentDraft = initialPreview.drafts.find((draft) => draft.id === request.draftId)
    assert(currentDraft, "LIVE_PROJECT_CURRENT_PREVIEW_REQUIRED")
    assert.equal(currentDraft.revision, request.revision, "LIVE_PROJECT_PREVIEW_REVISION_CHANGED")
    const draftCard = panel.locator("article").filter({
      has: page.getByText(`${currentDraft.name} · 版本 ${currentDraft.revision}`, { exact: true })
    })
    let completedRetainedProjectId: string | undefined
    if (currentDraft.recovery) {
      const recovery = currentDraft.recovery
      assert.equal(recovery.digest, request.digest, "LIVE_PROJECT_RECOVERY_SOURCE_CHANGED")
      assert.equal(recovery.revision, request.revision, "LIVE_PROJECT_RECOVERY_REVISION_CHANGED")
      assert(!recovery.debugBranch, "LIVE_PROJECT_DEBUG_RECOVERY_FORBIDDEN")
      inside(artifactRoot, realpathSync(recovery.workspace))
      if (recovery.status === "completed") completedRetainedProjectId = recovery.projectId
      else {
        assert.equal(recovery.status, "needs-confirmation", "LIVE_PROJECT_RECOVERY_REVIEW_REQUIRED")
        await draftCard
          .getByRole("checkbox", { name: "恢复此版本的试用记录", exact: true })
          .check({ timeout: remaining() })
        await draftCard
          .getByRole("button", { name: "核对并恢复原试用", exact: true })
          .click({ timeout: remaining() })
        events.push({
          recovery: "native explicit preview confirmation",
          projectId: recovery.projectId,
          revision: recovery.revision,
          digest: recovery.digest,
          hasUnconfirmedEffects: recovery.hasUnconfirmedEffects
        })
        save()
      }
    } else if (!currentDraft.projectId) {
      assert(!request.journey?.projectId, "LIVE_RETAINED_PREVIEW_REQUIRES_NATIVE_RECOVERY")
      if (input.goal)
        await panel
          .getByRole("textbox", { name: "这次试用希望完成什么", exact: true })
          .fill(input.goal, { timeout: remaining() })
      await draftCard
        .getByRole("button", { name: "准备试用环境", exact: true })
        .click({ timeout: remaining() })
    }
    const preview = await until(
      previews,
      (value) =>
        Boolean(
          completedRetainedProjectId ||
          value.drafts.find((draft) => draft.id === request.draftId)?.projectId
        ),
      "LIVE_PROJECT_PREVIEW_NOT_CREATED"
    )
    projectId =
      completedRetainedProjectId ??
      preview.drafts.find((draft) => draft.id === request.draftId)!.projectId!
  }
  const trialCreated = await page.evaluate(
    (id) => window.api.harnessBoard.localProjects.get(id),
    projectId
  )
  if (request.journey?.projectId)
    assert.equal(projectId, request.journey.projectId, "LIVE_RETAINED_TRIAL_PROJECT_CHANGED")
  projectWorkspaces.set(trialCreated.project.name, trialCreated.project.workspace)
  await openUnifiedHostProject(page, trialCreated.project.name)
  const trial = await runProject(trialCreated, "trial")
  const passed = await status()
  assert.equal(passed.projectTrial?.digest, request.digest, "LIVE_PROJECT_TESTED_CANDIDATE_CHANGED")
  assert.equal(passed.projectTrial?.journey?.canDeliver, true, "LIVE_PROJECT_TRIAL_NOT_ACCEPTED")
  assert.equal(passed.projectTrial?.journey?.phase, "passed", "LIVE_PROJECT_TRIAL_NOT_PASSED")
  events.push({ trial })
  save()

  // The creator dialog can reopen asynchronously when switching back to its chat.
  // Keep a scoped UI handler during navigation so that late modal opening cannot block the click.
  await page.removeLocatorHandler(creator)
  await page.addLocatorHandler(creator, async (dialog) => {
    await dialog.getByRole("button", { name: "Close", exact: true }).click({ timeout: remaining() })
  })
  try {
    const back = page.getByRole("button", { name: "返回会话", exact: true })
    if (await back.isVisible()) await back.click({ timeout: remaining() })
    await page.getByRole("tab", { name: "对话模式", exact: true }).click({ timeout: remaining() })
    const authorChat = page.locator(`[data-chat-thread-id=${JSON.stringify(authorThreadId)}]`)
    if (!(await authorChat.isVisible()))
      await page.getByText(author.title, { exact: true }).first().click({ timeout: remaining() })
    assert(await authorChat.isVisible(), "LIVE_PROJECT_AUTHOR_NOT_DISPLAYED")
  } finally {
    await page.removeLocatorHandler(creator)
  }
  const deliveryPanel = await openCreatorStep(page, "delivery")
  const card = deliveryPanel.getByRole("region", { name: "项目候选保存为新插件", exact: true })
  let installed = await status()
  if (
    installed.projectDelivery?.phase !== "installed" ||
    installed.projectDelivery.sourceDigest !== request.digest
  ) {
    const nameField = card.getByRole("textbox", { name: "新插件标识", exact: true })
    if (await nameField.isVisible()) {
      const previousName = await nameField.inputValue()
      const plugins = await page.evaluate(() => window.api.plugins.list())
      const nextName = liveProjectDeliveryName(
        previousName,
        request.digest,
        plugins.map((plugin) => plugin.name)
      )
      if (nextName !== previousName) {
        events.push({
          operation: "delivery-name-collision",
          sourceDigest: request.digest,
          previousName,
          newName: nextName,
          retainedPluginIds: plugins
            .filter((plugin) => plugin.name === previousName)
            .map((plugin) => plugin.id)
        })
        save()
        await nameField.fill(nextName, { timeout: remaining() })
      }
    }
    await card
      .getByRole("button", { name: "保存插件", exact: true })
      .click({ timeout: remaining() })
    installed = await until(
      status,
      (value) =>
        value.projectDelivery?.phase === "installed" &&
        value.projectDelivery.sourceDigest === request.digest,
      "LIVE_PROJECT_INSTALL_NOT_COMPLETED"
    )
  }
  const delivery = installed.projectDelivery!
  assert.equal(delivery.sourceDigest, request.digest, "LIVE_PROJECT_INSTALLED_CANDIDATE_CHANGED")
  assert(delivery.pluginId, "LIVE_PROJECT_INSTALLED_ID_REQUIRED")
  const plugin = await page.evaluate(
    async (id) => (await window.api.plugins.list()).find((value) => value.id === id),
    delivery.pluginId
  )
  assert(plugin, "LIVE_PROJECT_INSTALLATION_NOT_FOUND")
  const zip = await reimportLiveProjectZip({
    app: input.app,
    page,
    card,
    threadId: authorThreadId,
    workspace: authorWorkspace,
    artifacts: input.artifacts,
    delivery,
    plugin,
    deadline
  })
  events.push({ operation: "zip-original-upload", ...zip.evidence, identity: zip.identity })
  save()
  const suffix = request.digest.slice(0, 12)
  const originalFeature = await exerciseLiveOriginalFeatureJourney({
    app: input.app,
    page,
    isolationRoot: input.artifacts,
    workspaceParent: input.artifacts,
    artifacts: input.artifacts,
    artifactPrefix: `${artifactPrefix}-installed`,
    installed: {
      pluginId: zip.plugin.id,
      name: zip.plugin.name,
      version: zip.plugin.version,
      sourceDigest: zip.identity.digest
    },
    project: {
      name: `Live original project ${suffix}`,
      code: `LIVE${suffix}`,
      systemId: "MODS-ACCEPTANCE",
      systemName: "Isolated Mods acceptance",
      folder: `project-${suffix}`
    },
    feature: { title: `Handoff ${suffix}`, goal: input.goal ?? trialCreated.project.goal },
    deadline,
    execution: {
      providerBoundary: "commercial",
      maxStageTransitions: 1,
      confirmStage(view, operation) {
        assert.deepEqual(view.project.manifest.stages, trialCreated.project.manifest.stages)
        assert.deepEqual(view.project.manifest.checks, trialCreated.project.manifest.checks)
        assert.equal(view.project.manifest.actions.length, 0)
        return (
          operation.status === "prepared" &&
          operation.stageId === view.project.manifest.stages[0].id
        )
      },
      confirmKnownResult(view) {
        const operation = view.operations.find(
          (value) => value.operationId === view.resultReview?.operationId
        )
        if (
          !operation ||
          operation.status !== "succeeded" ||
          operation.execution?.terminal?.outcome !== "success" ||
          !operation.receipts.length ||
          !operation.receipts.every((receipt) => receipt.result === "passed")
        )
          return false
        const workspace = realpathSync(view.project.workspace)
        inside(artifactRoot, workspace)
        const files = view.project.manifest.artifacts.filter((artifact) =>
          existsSync(join(workspace, artifact.path))
        )
        for (const artifact of files) {
          const path = privatePath(workspace, resolve(workspace, artifact.path))
          assert(statSync(path).isFile(), "LIVE_ORIGINAL_RESULT_NOT_FILE")
          assert(statSync(path).size <= 2 * 1024 * 1024, "LIVE_ORIGINAL_RESULT_TOO_LARGE")
          const text = readFileSync(path, "utf8")
          if (artifact.path.endsWith(".json")) JSON.parse(text)
          events.push({
            operation: "original-result-read",
            path: artifact.path,
            bytes: Buffer.byteLength(text),
            sha256: createHash("sha256").update(text).digest("hex")
          })
        }
        save()
        return files.length > 0
      }
    },
    beginStage: input.beginStage,
    endStage: input.endStage
  })
  events.push({ originalFeature })
  save()
  return {
    model: "real configured provider",
    controlledOutputs: false,
    reviewedCommand,
    reviewedCommands,
    sameCandidateDigest: request.digest,
    trial,
    originalFeature,
    zip: zip.evidence,
    delivery: {
      id: delivery.id,
      pluginId: zip.plugin.id,
      originalPluginId: delivery.pluginId,
      sourceDigest: delivery.sourceDigest,
      digest: zip.identity.digest,
      name: zip.plugin.name,
      version: zip.plugin.version
    }
  }
}
