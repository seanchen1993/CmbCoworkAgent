/** Short final-ASAR faults through native install, Hooks, original Host and creator transport.
 * No private manager/CAS writes, synthetic source tokens, altered business ZIP or fake receipts.
 */
import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { createServer } from "node:http"
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync
} from "node:fs"
import { delimiter, dirname, join, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
import type { ElectronApplication, Page } from "playwright"
import { formatSkillUseBlock } from "../src/shared/skill-use-block"
import type {
  LocalProjectCommand,
  LocalProjectView
} from "../src/shared/project-runtime/platform-api"
import {
  FAULT_CONTEXT,
  FAULT_PROMPT_HOOK_POLICY,
  FAULT_PROMPT_HOOK_SKILL,
  foundationEarlyPromptHookPackage,
  foundationPromptHookPayload,
  foundationContextProvider,
  foundationFaultProject,
  foundationFailedOperationOnly,
  foundationNativeHookNotices,
  foundationRequiredContextRejection,
  foundationFunctionPackage,
  foundationInvalidContract
} from "./support/foundation-fault-packages"
import {
  createHeadlessProjectCompositionLaunch,
  projectCompositionCandidate,
  projectCompositionEnvironment
} from "./support/project-composition-e2e-fixtures"

const root = resolve(__dirname, "..")
assert(process.env.COMPOSITION_E2E_PACKAGED_DIR, "Explicit final ASAR required; no built fallback")
const candidate = projectCompositionCandidate(root)
assert.equal(candidate.execution, "packaged-asar")
assert.equal(candidate.sha256, process.env.CREATOR_E2E_EXPECTED_SHA256)
const fixture = projectCompositionEnvironment(root)
assert(
  process.env.GIT_BASH_PATH && existsSync(process.env.GIT_BASH_PATH),
  "Set GIT_BASH_PATH to the real Git Bash executable for the original required Python command"
)
const pathKey = Object.keys(fixture.env).find((key) => key.toLowerCase() === "path")
const inheritedPath = pathKey ? fixture.env[pathKey] : ""
if (pathKey) delete fixture.env[pathKey]
fixture.env.PATH = [dirname(process.env.GIT_BASH_PATH), inheritedPath]
  .filter(Boolean)
  .join(delimiter)
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")
const checks: string[] = [],
  requests: Array<{ case: string; body: Record<string, unknown> }> = []
const hookRequests: unknown[] = [],
  errors: string[] = []
const evidence: Record<string, unknown> = {
  passed: false,
  candidate,
  limitations: [
    "Controlled loopback model and test-only packages; no enterprise quality claim.",
    "Creator hard-money and lower attempt limits have no public writable entry. No CAS/production limit injection; original 192 transport/CAS regressions cover those rejections.",
    "Cancellation proves actual owned required Python process exit and original terminal/receipt behavior; it does not replace every missing-interpreter or platform cleanup regression."
  ]
}
let app: ElectronApplication | undefined, page: Page
let currentCase = "bootstrap"
let heldResponseClosed = false
let heldRequestStarted = false
const earlyHookUserText = `Verify native early Hook accounting ${randomUUID()}`
let earlyHookPrompt = ""
const earlyHookPayloads: Record<string, unknown>[] = []
const originalFile = join(fixture.workspace, "input-original.txt")
const firstFile = join(fixture.workspace, "input-first.txt")
const finalFile = join(fixture.workspace, "input-final.txt")
for (const [path, text] of [
  [originalFile, "ORIGINAL"],
  [firstFile, "FIRST"],
  [finalFile, "ACTUAL_FINAL_INPUT"]
])
  writeFileSync(path, text)
writeFileSync(join(fixture.workspace, "knowledge.txt"), FAULT_CONTEXT)
const pause = () => new Promise<void>((done) => setTimeout(done, 100))

const server = createServer(async (request, response) => {
  try {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>
    if (request.url?.startsWith("/transform/")) {
      hookRequests.push({ path: request.url, body })
      const second = request.url.endsWith("second")
      response.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          updatedInput: { file_path: second ? finalFile : firstFile },
          additionalContext: second ? "SECOND_TRANSFORM_RETAINED" : "FIRST_TRANSFORM_RETAINED"
        })
      )
      return
    }
    assert.equal(request.url, "/v1/chat/completions")
    requests.push({ case: currentCase, body })
    assert(requests.length < 25, "The short fault probe must not become an automatic repair loop")
    const messages = body.messages as Array<{
      role: string
      content: unknown
      tool_calls?: unknown[]
    }>
    const combined = JSON.stringify(messages)
    const toolResults = messages.filter((message) => message.role === "tool")
    if (currentCase === "creator-early-hook") {
      const payload = foundationPromptHookPayload(body, earlyHookPrompt)
      if (payload) {
        assert.equal(
          earlyHookPayloads.length,
          0,
          "Only one original UserPromptSubmit Hook may execute"
        )
        assert.equal(resolve(String(payload.workspace)), resolve(fixture.workspace))
        earlyHookPayloads.push(payload)
        response.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            id: "foundation-actual-early-hook",
            object: "chat.completion",
            created: 1,
            model: body.model,
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: '{"decision":"allow"}' },
                finish_reason: "stop"
              }
            ]
          })
        )
        return
      }
      assert.equal(
        earlyHookPayloads.length,
        1,
        "Original prompt Hook must finish before the primary provider"
      )
      assert(
        messages.some(
          (message) =>
            message.role === "user" && message.content === earlyHookPrompt
        )
      )
    }
    if (currentCase === "creator-hold") {
      response.writeHead(200, { "content-type": "text/event-stream" })
      response.flushHeaders()
      response.on("close", () => {
        heldResponseClosed = true
      })
      heldRequestStarted = true
      return
    }
    let delta: Record<string, unknown> = { role: "assistant", content: "FOUNDATION_FAULT_DONE" }
    let finish = "stop"
    if ((currentCase === "transforms" || currentCase.startsWith("check-")) && !toolResults.length) {
      const skill = /<path>([^<]+)<\/path>/.exec(combined)?.[1]
      const filePath = currentCase === "transforms" ? originalFile : skill
      assert(filePath, "Actual host Skill source must reach the model")
      const tools = body.tools as Array<{ function: { name: string } }>
      assert(tools.some((tool) => tool.function.name === "read_file"))
      delta = {
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: `fault-read-${requests.length}`,
            type: "function",
            function: { name: "read_file", arguments: JSON.stringify({ file_path: filePath }) }
          }
        ]
      }
      finish = "tool_calls"
    }
    if (currentCase === "transforms" && toolResults.length)
      assert(
        combined.includes("ACTUAL_FINAL_INPUT"),
        "Original native tool must consume the later transformed input"
      )
    const packet = (change: unknown, reason: string | null) => ({
      id: `fault-${requests.length}`,
      object: "chat.completion.chunk",
      created: 1,
      model: body.model,
      choices: [{ index: 0, delta: change, finish_reason: reason }]
    })
    response.writeHead(200, { "content-type": "text/event-stream" })
    response.write(`data: ${JSON.stringify(packet(delta, null))}\n\n`)
    // Missing creator usage deliberately remains unknown; real host calls report actual fixture counts.
    response.write(
      `data: ${JSON.stringify({
        ...packet({}, finish),
        ...(currentCase.startsWith("creator")
          ? {}
          : { usage: { prompt_tokens: 21, completion_tokens: 3, total_tokens: 24 } })
      })}\n\n`
    )
    response.end("data: [DONE]\n\n")
  } catch (error) {
    errors.push(String(error))
    if (!response.headersSent) response.writeHead(500)
    response.end("Foundation fixture failed")
  }
})

async function until<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  label: string,
  timeout = 30000
): Promise<T> {
  const deadline = Date.now() + timeout
  do {
    const value = await read()
    if (accept(value)) return value
    assert.deepEqual(errors, [])
    await pause()
  } while (Date.now() < deadline)
  throw Error(`Foundation fault probe timed out: ${label}`)
}

async function install(zip: ReturnType<typeof foundationFunctionPackage>, name: string) {
  const result = await page.evaluate(
    ({ bytes, name }) =>
      window.api.plugins.install(new Uint8Array(bytes).buffer, `${name}.zip`, "local"),
    { bytes: [...zip.toBuffer()], name }
  )
  assert(result.success && result.pluginId, result.error ?? JSON.stringify(result))
  return result.pluginId
}

async function nativeThread(title: string, workspace = fixture.workspace) {
  return page.evaluate(
    async ({ title, workspace }) => {
      const thread = await window.api.threads.create({
        title,
        workspacePath: workspace,
        agentMode: "normal"
      })
      await window.api.workspace.set(thread.thread_id, workspace)
      const current = await window.api.mods.status(thread.thread_id)
      await window.api.mods.configure(thread.thread_id, true, true, current.workspace)
      return { threadId: thread.thread_id, expectedWorkspace: current.workspace }
    },
    { title, workspace }
  )
}

async function approveFunction(threadId: string, pluginId: string, workspace: string) {
  return page.evaluate(
    async ({ threadId, pluginId, workspace }) => {
      const status = await window.api.mods.status(threadId)
      const source = status.functionMods?.find((mod) => mod.pluginId === pluginId)
      if (!source?.digest) throw Error(JSON.stringify(status))
      await window.api.mods.approveFunction(threadId, pluginId, source.digest, workspace)
      return { pluginId, name: source.name, digest: source.digest }
    },
    { threadId, pluginId, workspace }
  )
}

async function invoke(threadId: string, prompt: string, model = "custom:foundation-a") {
  return page.evaluate(
    ({ threadId, prompt, model }) =>
      new Promise<unknown[]>((done, reject) => {
        const events: unknown[] = []
        let cleanup = () => {
          /* Assigned by the original typed invoke entry. */
        }
        const timer = setTimeout(() => {
          cleanup()
          reject(Error("Original invoke did not terminate"))
        }, 45000)
        cleanup = window.api.agent.invoke(
          threadId,
          prompt,
          (event) => {
            events.push(event)
            if (event.type === "error" || event.type === "done") {
              clearTimeout(timer)
              cleanup()
              done(events)
            }
          },
          model,
          "normal"
        )
      }),
    { threadId, prompt, model }
  )
}

const command = (id: string, value: LocalProjectCommand) =>
  page.evaluate(({ id, value }) => window.api.harnessBoard.localProjects.command(id, value), {
    id,
    value
  })

/** Read the original persisted provider facts, never write a result or grant. */
function originalContextFacts(threadId: string): unknown[] {
  const db = new DatabaseSync(join(fixture.env.CMB_COWORK_AGENT_HOME, "mods-control.sqlite"), {
    readOnly: true
  })
  try {
    const rows = db.prepare("SELECT key,value FROM mods_meta").all()
    const row = rows.find((row) => {
      try {
        const key = JSON.parse(String(row.key))
        return key[0] === "diy-flow-v1" && key[1] === "runs" && key[3] === threadId
      } catch {
        return false
      }
    })
    assert(row, "The original native provider Flow must have persisted actual invocation facts")
    const runs = JSON.parse(String(row.value)) as Array<{
      attempts: Array<{ __nativeActionFacts?: { threadId: string; contextText?: string } }>
    }>
    const facts = runs.flatMap((run) =>
      run.attempts.flatMap((attempt) =>
        attempt.__nativeActionFacts ? [attempt.__nativeActionFacts] : []
      )
    )
    assert(facts.every((fact) => fact.threadId === threadId))
    assert(
      facts.some((fact) => fact.contextText?.includes(FAULT_CONTEXT)),
      "Actual required context must resolve before the destructive prompt Hook"
    )
    return facts
  } finally {
    db.close()
  }
}

async function createProject(pluginId: string, name: string) {
  let view = await page.evaluate((input) => window.api.harnessBoard.localProjects.create(input), {
    installedPluginId: pluginId,
    workspace: fixture.workspace,
    name,
    goal: "Run original fault gates; do not fabricate an artifact or a success receipt."
  })
  const review = await page.evaluate(
    (id) => window.api.harnessBoard.localProjects.mods.read(id),
    view.project.projectId
  )
  assert(review.source?.digest)
  const approved = await page.evaluate(
    (input) => window.api.harnessBoard.localProjects.mods.approve(input),
    {
      projectId: view.project.projectId,
      projectVersion: view.project.version,
      packageDigest: view.project.pluginDigest,
      compiledDigest: review.source.digest
    }
  )
  assert.equal(approved.source?.state, "ready")
  view = await page.evaluate(
    (id) => window.api.harnessBoard.localProjects.get(id),
    view.project.projectId
  )
  view = await command(view.project.projectId, {
    kind: "prepare",
    expectedVersion: view.project.version,
    idempotencyKey: randomUUID()
  })
  return command(view.project.projectId, {
    kind: "approve",
    operationId: view.operations[0].operationId,
    expectedVersion: view.project.version,
    inputFingerprint: view.operations[0].inputFingerprint,
    decision: "approved"
  })
}

async function main() {
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  const address = server.address()
  assert(address && typeof address !== "string")
  const endpoint = `http://127.0.0.1:${address.port}`
  const watchdog = setTimeout(() => void app?.close(), 300000)
  try {
    app = await createHeadlessProjectCompositionLaunch(root, fixture, {
      unobtrusivePresentation: true
    })()
    for (const [name, stream] of [
      ["stdout", app.process().stdout],
      ["stderr", app.process().stderr]
    ] as const)
      stream?.on("data", (bytes) =>
        appendFileSync(join(fixture.isolated, `main.${name}.log`), bytes)
      )
    const actualApp = await app.evaluate(({ app }) => ({
      packaged: app.isPackaged,
      root: app.getAppPath()
    }))
    assert(actualApp.packaged)
    assert.equal(resolve(actualApp.root), resolve(candidate.path))
    evidence.actualApp = actualApp
    page = await app.firstWindow({ timeout: 60000 })
    page.on("pageerror", (error) => errors.push(error.message))
    await page.waitForFunction(() => Boolean(window.api?.mods?.development))
    await page.evaluate(() => {
      ;(globalThis as unknown as { __name: unknown }).__name = Function("value", "return value")
    })
    await page.evaluate(async (endpoint) => {
      await window.api.autoCommit.saveSettings({ mode: "off", push: false })
      await window.api.mods.configureGlobal(true)
      await window.api.hooks.logging.save({ enabled: true, diagnostic: true })
      for (const name of ["a", "b"])
        await window.api.models.setCustomConfig({
          id: `foundation-${name}`,
          name: `Foundation ${name}`,
          baseUrl: `${endpoint}/v1`,
          model: `foundation-${name}`,
          apiKey: "isolated-loopback",
          maxTokens: 32000,
          maxOutputTokens: 1000
        })
      await window.api.models.setDefault("custom:foundation-a")
    }, endpoint)

    // A06: real global Hooks, original model tool and original streamed diagnostic.
    const normal = await nativeThread("Foundation ordered transforms")
    const hookIds: string[] = []
    for (const name of ["first", "second"])
      hookIds.push(
        (
          await page.evaluate((input) => window.api.hooks.create(input), {
            event: "PreToolUse" as const,
            matcher: "read_file",
            type: "http" as const,
            url: `${endpoint}/transform/${name}`,
            timeout: 5000,
            enabled: true
          })
        ).id
      )
    currentCase = "transforms"
    const events = await invoke(
      normal.threadId,
      "FOUNDATION_TRANSFORM_READ: read the original input once."
    )
    assert.equal(hookRequests.length, 2)
    const notices = foundationNativeHookNotices(events)
    assert(
      notices.some((value) => String(value.systemMessage).includes("/file_path")),
      "The actual native Hook event must expose the bounded same-field conflict diagnostic"
    )
    const serialized = JSON.stringify(notices)
    assert(
      serialized.includes("FIRST_TRANSFORM_RETAINED") &&
        serialized.includes("SECOND_TRANSFORM_RETAINED")
    )
    evidence.orderedTransforms = { events, hookRequests }
    for (const id of hookIds) await page.evaluate((id) => window.api.hooks.delete(id), id)
    checks.push(
      "A06 real ordered native transforms consumed final bytes and emitted conflict/source diagnostics"
    )

    // A23: malformed candidates must fail the real installer and remain unavailable.
    const pluginsBefore = await page.evaluate(() => window.api.plugins.list())
    const rejected: unknown[] = []
    for (const kind of ["missing", "unsupported"] as const) {
      const invalid = foundationInvalidContract(fixture.workspace, kind)
      const result = await page.evaluate(
        ({ bytes, name }) =>
          window.api.plugins.install(new Uint8Array(bytes).buffer, `${name}.zip`, "local"),
        { bytes: [...invalid.zip.toBuffer()], name: invalid.name }
      )
      assert.equal(result.success, false)
      assert.match(
        String(result.error),
        kind === "missing"
          ? /EXTENSION_CONTRACT_INVALID/
          : /EXTENSION_CONTRACT_PROTOCOL_UNSUPPORTED/
      )
      rejected.push({ kind, result })
      assert(
        !(await page.evaluate(() => window.api.harnessBoard.localProjects.templates())).some(
          (template) => template.name === invalid.name && !template.unavailableReason
        )
      )
    }
    assert.deepEqual(await page.evaluate(() => window.api.plugins.list()), pluginsBefore)
    evidence.contractRejections = rejected
    checks.push(
      "A23 actual installer/templates reject missing required v2 contract and unknown protocol"
    )

    const contextId = await install(foundationContextProvider(), "foundation-context")
    await approveFunction(normal.threadId, contextId, normal.expectedWorkspace)
    const catalog = await page.evaluate((id) => window.api.mods.flowCatalog(id), normal.threadId)
    const context = catalog.actions?.find(
      (item) => item.actionId === "context" && item.pluginId === contextId
    )
    assert(context, JSON.stringify(catalog))
    const faults: Record<string, unknown> = {}
    let errorPluginId = ""
    for (const mode of ["remove-context", "check-error", "check-cancel"] as const) {
      const pluginId = await install(foundationFaultProject(fixture.workspace, context, mode), mode)
      if (mode === "check-error") errorPluginId = pluginId
      const view = await createProject(pluginId, mode)
      const requestCount = requests.length
      const stderrPath = join(fixture.isolated, "main.stderr.log")
      const priorStderrBytes = existsSync(stderrPath) ? readFileSync(stderrPath).length : 0
      currentCase = mode
      const starting = command(view.project.projectId, {
        kind: "start",
        operationId: view.operations[0].operationId
      })
      let result: LocalProjectView | undefined, error: string | undefined
      let startingSettled = false
      const settled = starting.then(
        (value) => {
          result = value
          startingSettled = true
        },
        (value) => {
          error = String(value)
          startingSettled = true
        }
      )
      if (mode === "check-cancel") {
        const pidFile = join(fixture.workspace, "native-check-pid.json")
        await until(async () => existsSync(pidFile), Boolean, "actual required Python check birth")
        const processFact = JSON.parse(readFileSync(pidFile, "utf8")) as {
          pid: number
          cwd: string
          workspace: string
          startedAt: number
          naturalExitAfterMs: number
        }
        assert(Number.isSafeInteger(processFact.pid) && processFact.pid > 0)
        assert.equal(resolve(processFact.workspace), resolve(fixture.workspace))
        assert(
          resolve(processFact.cwd).startsWith(resolve(fixture.isolated)),
          "Only a captured test package may own this Python process"
        )
        assert(Number.isSafeInteger(processFact.startedAt))
        assert.equal(processFact.naturalExitAfterMs, 30000)
        const naturalExitFile = join(fixture.workspace, "native-check-natural-exit.json")
        assert(!existsSync(naturalExitFile))
        process.kill(processFact.pid, 0)
        const cancelRequestedAt = Date.now()
        const requestsAtCancel = requests.length
        const cancelled = await command(view.project.projectId, {
          kind: "cancel",
          operationId: view.operations[0].operationId
        })
        const cancelReturnedAt = Date.now()
        const processAlive = (): boolean => {
          try {
            process.kill(processFact.pid, 0)
            return true
          } catch (cause) {
            if ((cause as NodeJS.ErrnoException).code === "ESRCH") return false
            throw cause
          }
        }
        const aliveAtCancelReturn = processAlive()
        const operationId = view.operations[0].operationId
        const initialCancelOperation = cancelled.operations.find(
          (item) => item.operationId === operationId
        )
        assert(initialCancelOperation)
        assert(["cancel_requested", "cancelled", "unknown"].includes(initialCancelOperation.status))
        assert(Number.isSafeInteger(initialCancelOperation.cancelRequestedAt))
        assert(!initialCancelOperation.receipts.some((receipt) => receipt.result === "passed"))
        if (initialCancelOperation.status === "cancelled") {
          assert(
            !aliveAtCancelReturn,
            "A known cancelled result requires physical exit before return"
          )
        }
        let finalCancelStatus: "cancelled" | "unknown" | undefined
        const settledView = await until(
          async () => {
            assert(
              app && app.process().exitCode === null,
              "Observe cleanup while the original App is alive"
            )
            assert(!existsSync(naturalExitFile), "Natural sample completion is not owned cleanup")
            assert.equal(
              requests.length,
              requestsAtCancel,
              "Unknown must not advance or replay the model"
            )
            const observed = await page.evaluate(
              (id) => window.api.harnessBoard.localProjects.get(id),
              view.project.projectId
            )
            const operation = observed.operations.find((item) => item.operationId === operationId)
            assert(operation)
            assert(["cancel_requested", "unknown", "cancelled"].includes(operation.status))
            assert(!operation.receipts.some((receipt) => receipt.result === "passed"))
            assert.equal(observed.project.stageIndex, view.project.stageIndex)
            assert.notEqual(observed.project.status, "completed")
            const alive = processAlive()
            if (operation.status === "cancelled")
              assert(!alive, "Known cancellation cannot precede physical exit")
            if (operation.status === "cancel_requested") return undefined
            assert(foundationFailedOperationOnly(operation))
            if (!startingSettled || !operation.execution?.terminal || alive) return undefined
            finalCancelStatus = operation.status as "cancelled" | "unknown"
            return observed
          },
          (value) => value !== undefined,
          "original execution terminal and owned cleanup before sample natural exit",
          10000
        )
        assert(settledView && startingSettled && finalCancelStatus)
        const childExitObservedAt = Date.now()
        assert(childExitObservedAt < processFact.startedAt + processFact.naturalExitAfterMs)
        assert(!existsSync(naturalExitFile))
        await pause()
        const afterPhysicalExit = await page.evaluate(
          (id) => window.api.harnessBoard.localProjects.get(id),
          view.project.projectId
        )
        const finalOperation = afterPhysicalExit.operations.find(
          (item) => item.operationId === operationId
        )
        assert(finalOperation)
        assert.equal(finalOperation.status, finalCancelStatus)
        assert(foundationFailedOperationOnly(finalOperation))
        assert(finalOperation.execution?.terminal)
        assert.equal(afterPhysicalExit.project.stageIndex, view.project.stageIndex)
        assert.equal(
          requests.length,
          requestsAtCancel,
          "Physical exit must not replay or advance the model"
        )
        faults.cancel = {
          processFact,
          cancelled,
          settledView,
          result,
          error,
          afterPhysicalExit,
          cancelRequestedAt,
          cancelReturnedAt,
          childExitObservedAt,
          aliveAtCancelReturn,
          configuredHookTimeoutMs: 3000,
          naturalExitObserved: existsSync(naturalExitFile)
        }
      } else {
        await settled
        result = await page.evaluate(
          (id) => window.api.harnessBoard.localProjects.get(id),
          view.project.projectId
        )
        assert(
          foundationFailedOperationOnly(result.operations[0]),
          JSON.stringify(result.operations[0])
        )
        faults[mode] = { result, error }
        if (mode === "remove-context") {
          assert.equal(
            requests.length,
            requestCount,
            "Removing required resolved context must be rejected before the actual provider send"
          )
          const threadId = result.operations[0].execution?.threadId
          assert(threadId)
          const contextFacts = originalContextFacts(threadId)
          const stderr = await until(
            async () =>
              existsSync(stderrPath)
                ? readFileSync(stderrPath).subarray(priorStderrBytes).toString("utf8")
                : "",
            foundationRequiredContextRejection,
            "exact original required-context rejection"
          )
          faults[mode] = { result, error, contextFacts, stderr }
        }
      }
      const after = await page.evaluate(
        (id) => window.api.harnessBoard.localProjects.get(id),
        view.project.projectId
      )
      assert(
        foundationFailedOperationOnly(after.operations[0]),
        JSON.stringify(after.operations[0])
      )
      assert.notEqual(after.project.status, "completed")
      // Preserve an accurately unknown operation; the next probe owns a different project.
      await page.evaluate((id) => window.api.plugins.setEnabled(id, false), pluginId)
    }
    const logDirectory = await page.evaluate(() => window.api.hooks.logging.getLogDir())
    assert(resolve(logDirectory).startsWith(resolve(fixture.isolated)))
    const logs = await until(
      async () =>
        existsSync(logDirectory)
          ? readdirSync(logDirectory)
              .filter((name) => name.endsWith(".jsonl"))
              .flatMap((name) =>
                readFileSync(join(logDirectory, name), "utf8")
                  .split("\n")
                  .filter(Boolean)
                  .map((line) => JSON.parse(line))
              )
          : [],
      (rows) =>
        rows.some((value) => {
          if (!value || typeof value !== "object") return false
          const row = value as Record<string, unknown>
          return (
            row.pluginId === errorPluginId &&
            row.event === "PreToolUse" &&
            row.kind === "executed" &&
            row.blocked === true &&
            row.decision === "block" &&
            String(row.reason).includes("REQUIRED_BUSINESS_CHECK_FAILED") &&
            String(row.stderr).includes("FOUNDATION_REQUIRED_CHECK_EXCEPTION")
          )
        }),
      "original required-check diagnostic persistence"
    )
    evidence.requiredCheckLogs = logs
    evidence.requiredFaults = faults
    checks.push(
      "A14 required context removal never reaches HTTP; A08 original required exception/cancellation never emits success receipts"
    )

    // A20/A25/A22: real creator model switch, damaged optional policy fallback, native Stop and native recovery.
    const creator = await nativeThread("Foundation creator accounting")
    await page.evaluate(async (scope) => {
      await window.api.mods.development.setEnabled({ ...scope, enabled: true })
      await window.api.mods.development.setMode({ ...scope, mode: "creator" })
    }, creator)
    const strategyId = await install(
      foundationFunctionPackage(
        "foundation-planning",
        'export function register(on){on("prompt.section",{name:"creator.planning"},async()=>({text:"FOUNDATION_OPTIONAL_STRATEGY"}))}'
      ),
      "foundation-planning"
    )
    const strategy = await approveFunction(creator.threadId, strategyId, creator.expectedWorkspace)
    const selected = await page.evaluate(
      async ({ scope, selected }) => {
        const catalog = await window.api.mods.development.planningCatalog!(scope)
        return window.api.mods.development.selectPlanning!({
          ...scope,
          expectedRevision: catalog.status.revision,
          selected
        })
      },
      { scope: creator, selected: strategy }
    )
    assert.equal(selected.status.state, "ready")
    currentCase = "creator-a"
    const firstCount = requests.length
    await invoke(creator.threadId, "Explain this new human request without tools.")
    assert(requests.length > firstCount)
    assert(requests.slice(firstCount).every((item) => item.body.model === "foundation-a"))
    assert(
      requests
        .slice(firstCount)
        .some((item) => JSON.stringify(item.body).includes("FOUNDATION_OPTIONAL_STRATEGY"))
    )
    const firstAccounting = await until(
      () =>
        page.evaluate(
          (scope) => window.api.mods.development.status({ threadId: scope.threadId }),
          creator
        ),
      (status) =>
        Boolean(
          status.request &&
          "model" in status.request &&
          status.request.model?.usagePendingAttempts === 0
        ),
      "first original creator model settlement"
    )
    const plugin = (await page.evaluate(() => window.api.plugins.list())).find(
      (item) => item.id === strategyId
    )!
    assert(
      resolve(plugin.path).startsWith(resolve(fixture.isolated) + "/") ||
        resolve(plugin.path).startsWith(resolve(fixture.isolated) + "\\")
    )
    writeFileSync(
      join(plugin.path, "mods/register.ts"),
      'export function register(){throw Error("owned-test-policy-corruption")}'
    )
    const fallback = await page.evaluate(
      (scope) => window.api.mods.development.planningCatalog!(scope),
      creator
    )
    assert.equal(fallback.status.state, "fallback")
    assert(fallback.status.diagnostic)
    await page.evaluate(() => window.api.models.setDefault("custom:foundation-b"))
    currentCase = "creator-b"
    const secondCount = requests.length
    await invoke(
      creator.threadId,
      "A genuinely new human request after strategy failure. Explain only.",
      "custom:foundation-b"
    )
    assert(requests.length > secondCount)
    assert(requests.slice(secondCount).every((item) => item.body.model === "foundation-b"))
    assert(
      requests
        .slice(secondCount)
        .every((item) => !JSON.stringify(item.body).includes("FOUNDATION_OPTIONAL_STRATEGY"))
    )
    const accounting = await until(
      () =>
        page.evaluate(
          (scope) => window.api.mods.development.status({ threadId: scope.threadId }),
          creator
        ),
      (status) =>
        Boolean(
          status.request &&
          "model" in status.request &&
          status.request.model?.usagePendingAttempts === 0
        ),
      "real creator transport and original trace settlement"
    )
    assert(accounting.request && "model" in accounting.request && accounting.request.model)
    const model = accounting.request.model
    assert(
      firstAccounting.request && "model" in firstAccounting.request && firstAccounting.request.model
    )
    const sameGroup = accounting.request.runId === firstAccounting.request.runId
    const priorAttempts = sameGroup ? firstAccounting.request.model.attempts : 0
    assert.equal(model.attempts, priorAttempts + requests.length - secondCount)
    assert(
      model.traceIds.length > 0 &&
        model.traceIds.every((id) => typeof id === "string" && id.length > 0)
    )
    assert(
      typeof model.recordedModelCalls === "number" &&
        model.recordedModelCalls > 0 &&
        model.recordedModelCalls <= model.attempts,
      "Logical original trace calls are independent of transport attempts"
    )
    const nativeTraces = await until(
      async () => {
        const traces = await page.evaluate(
          (threadId) => window.api.optimizer.getTraces({ threadId, limit: 30 }),
          creator.threadId
        )
        if (!model.traceIds.every((id) => traces.some((trace) => trace.traceId === id))) return []
        return page.evaluate(
          (ids) => Promise.all(ids.map((id) => window.api.optimizer.getTraceDetail(id))),
          model.traceIds
        )
      },
      (traces) => traces.length === model.traceIds.length,
      "original persisted trace references"
    )
    assert(nativeTraces.every((trace) => trace?.threadId === creator.threadId))
    assert.equal(
      nativeTraces.reduce((count, trace) => count + (trace?.modelCalls?.length ?? 0), 0),
      model.recordedModelCalls,
      "Accounting must reference actual original TraceCollector calls, not invented HTTP trace IDs"
    )
    assert.equal(model.coverage, "partial")
    assert(model.usageUnknownAttempts > 0)
    assert.deepEqual(model.cost, { state: "unavailable", reason: "pricing-unavailable" })
    assert(!Object.hasOwn(model.cost, "amount"))
    currentCase = "creator-hold"
    let heldEnded = false
    const heldTurn = invoke(
      creator.threadId,
      "A new human request to stop, keep optional policy broken.",
      "custom:foundation-b"
    ).then(
      (events) => {
        heldEnded = true
        return { events, error: undefined }
      },
      (error: unknown) => {
        heldEnded = true
        return { events: [], error: String(error) }
      }
    )
    await until(
      async () => {
        assert(
          !heldEnded || heldRequestStarted,
          "Creator ended before the real held provider request"
        )
        return heldRequestStarted
      },
      Boolean,
      "real held provider request",
      15000
    )
    assert(
      !heldEnded && !heldResponseClosed,
      "Native Stop must target the original still-running provider request"
    )
    await page.evaluate((id) => window.api.agent.cancel(id), creator.threadId)
    assert.equal((await heldTurn).error, undefined)
    await until(async () => heldResponseClosed, Boolean, "actual provider socket cancellation")
    const recovered = await page.evaluate(
      (scope) => window.api.mods.development.status({ threadId: scope.threadId }),
      creator
    )
    assert(recovered.enabled && recovered.planning?.state === "fallback")
    evidence.creatorAccounting = {
      selected,
      fallback,
      firstAccounting,
      sameGroup,
      accounting,
      nativeTraces,
      recovered,
      heldResponseClosed,
      sentModelIds: requests
        .filter((row) => row.case.startsWith("creator"))
        .map((row) => row.body.model)
    }
    checks.push(
      "A20/A25 real model replacement, broken optional planning fallback and native Stop retain original creator diagnostics"
    )
    checks.push(
      "A22 original status reports actual HTTP attempts, separate original trace model calls, unknown usage and absent money amount"
    )
    // Independent original creator/native Skill activation: the Hook sends before runtime birth.
    const earlyHookId = await install(foundationEarlyPromptHookPackage(), "early-prompt-hook")
    const hookEnabled = await page.evaluate(
      (id) => window.api.plugins.setEnabled(id, true),
      earlyHookId
    )
    assert(hookEnabled.success, hookEnabled.error)
    const earlyNativeHook = (await page.evaluate(() => window.api.plugins.listHooks())).find(
      (hook) =>
        hook.pluginId === earlyHookId && hook.event === "UserPromptSubmit" && hook.type === "prompt"
    )
    assert(earlyNativeHook?.pluginEnabled && earlyNativeHook.enabled)
    assert.equal(earlyNativeHook.prompt, FAULT_PROMPT_HOOK_POLICY)
    const earlyNativeSkill = (await page.evaluate(() => window.api.skills.listPlugins())).find(
      (skill) => skill.pluginId === earlyHookId && skill.name === FAULT_PROMPT_HOOK_SKILL
    )
    assert(earlyNativeSkill, "Original installed Skill catalog must supply the selected identity")
    // The original slash composer sends the human argument plus this shared transport block;
    // plain '/name' text alone never activates the main-process Skill lifecycle.
    earlyHookPrompt = `${earlyHookUserText}\n\n${formatSkillUseBlock(earlyNativeSkill)}`
    const earlyCreator = await nativeThread("Foundation native early prompt accounting")
    await page.evaluate(async (scope) => {
      await window.api.mods.development.setEnabled({ ...scope, enabled: true })
      await window.api.mods.development.setMode({ ...scope, mode: "creator" })
    }, earlyCreator)
    currentCase = "creator-early-hook"
    const earlyRequestIndex = requests.length
    const earlyEvents = await invoke(earlyCreator.threadId, earlyHookPrompt, "custom:foundation-b")
    const earlyRequests = requests.slice(earlyRequestIndex)
    assert.equal(earlyRequests.length, 2)
    assert(
      earlyRequests.every(
        (request) => request.case === "creator-early-hook" && request.body.model === "foundation-b"
      )
    )
    assert(foundationPromptHookPayload(earlyRequests[0].body, earlyHookPrompt))
    assert.equal(foundationPromptHookPayload(earlyRequests[1].body, earlyHookPrompt), undefined)
    const earlyNotices = foundationNativeHookNotices(earlyEvents).filter(
      (hook) =>
        hook.pluginId === earlyHookId &&
        hook.event === "UserPromptSubmit" &&
        hook.kind === "executed"
    )
    assert.equal(earlyNotices.length, 1)
    assert.equal(earlyNotices[0].decision, "approve")
    assert.equal(earlyNotices[0].blocked, false)
    const earlyAccounting = await until(
      () =>
        page.evaluate(
          (threadId) => window.api.mods.development.status({ threadId }),
          earlyCreator.threadId
        ),
      (status) =>
        !!(
          status.request &&
          "model" in status.request &&
          status.request.model?.attempts === 2 &&
          status.request.model.usagePendingAttempts === 0 &&
          status.request.model.recordedModelCalls === 1
        ),
      "original early-Hook plus primary CAS and native trace settlement"
    )
    assert(
      earlyAccounting.request && "model" in earlyAccounting.request && earlyAccounting.request.model
    )
    const earlyModel = earlyAccounting.request.model
    assert.equal(earlyModel.usageUnknownAttempts, 2)
    assert.equal(earlyModel.recordedModelCalls, 1)
    assert.equal(earlyModel.traceCoverage, "partial")
    assert.equal(earlyModel.traceIds.length, 1)
    assert.deepEqual(earlyModel.cost, { state: "unavailable", reason: "pricing-unavailable" })
    assert(!Object.hasOwn(earlyModel.cost, "amount"))
    const earlyTrace = await until(
      () =>
        page.evaluate(
          (traceId) => window.api.optimizer.getTraceDetail(traceId),
          earlyModel.traceIds[0]
        ),
      (trace) => trace?.threadId === earlyCreator.threadId && trace.modelCalls?.length === 1,
      "original persisted primary trace after native prompt Hook"
    )
    evidence.earlyPromptHookAccounting = {
      earlyHookId,
      earlyNativeHook,
      earlyNativeSkill,
      slashSelection: `/${FAULT_PROMPT_HOOK_SKILL} ${earlyHookUserText}`,
      actualNativeInput: earlyHookPrompt,
      earlyCreator,
      earlyEvents,
      earlyRequests,
      actualHookPayload: earlyHookPayloads[0],
      accounting: earlyAccounting,
      trace: earlyTrace
    }
    const hookDisabled = await page.evaluate(
      (id) => window.api.plugins.setEnabled(id, false),
      earlyHookId
    )
    assert(hookDisabled.success, hookDisabled.error)
    checks.push(
      "A22 native pre-runtime UserPromptSubmit plugin Hook and primary HTTP share original CAS (2 attempts / 1 native logical call), unknown usage/cost remain explicit"
    )
    assert.deepEqual(errors, [])
    assert.equal(hash(readFileSync(candidate.path)), candidate.sha256)
    evidence.passed = true
  } finally {
    clearTimeout(watchdog)
    mkdirSync(fixture.isolated, { recursive: true })
    writeFileSync(
      join(fixture.isolated, "evidence.json"),
      JSON.stringify({ ...evidence, checks, requests, errors }, null, 2)
    )
    server.closeAllConnections()
    await app?.close().catch(() => {})
    await new Promise<void>((done) => server.close(() => done()))
    console.log(JSON.stringify({ candidate, evidence: join(fixture.isolated, "evidence.json") }))
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
