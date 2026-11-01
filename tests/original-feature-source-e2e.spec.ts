/** Current-source native app; deterministic small JSON only, no commercial provider. */
import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { appendFileSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { isAbsolute, join, relative, resolve } from "node:path"
import AdmZip from "adm-zip"
import type { ElectronApplication, Page } from "playwright"
import type { ApprovalRequest } from "../src/main/types"
import {
  compileNativeComposition,
  type NativeComposition
} from "../src/main/plugins/native-composition"
import { exerciseLiveOriginalFeatureJourney } from "./support/live-original-feature-journey"
import {
  assertCreatorLiveCandidate,
  createHeadlessProjectCompositionLaunch,
  projectCompositionEnvironment
} from "./support/project-composition-e2e-fixtures"

const root = resolve(__dirname, "..")
const candidate = assertCreatorLiveCandidate(root)
assert.equal(candidate.execution, "source-isolated", "ORIGINAL_COMPLETION_REQUIRES_CURRENT_SOURCE")
const fixture = projectCompositionEnvironment(root)
const deadline = Date.now() + 10 * 60_000
const stages = ["implementation", "delivery", "audit"] as const
const packageId = "original-feature-handoff-fixture"
const source: NativeComposition = {
  apiVersion: "devclaw.native-composition/v1",
  plugin: {
    id: packageId,
    version: "1.0.0",
    title: "原项目最小衔接验收",
    description:
      "Deterministic text-only handoff fixture, never claimed as real model author output."
  },
  resources: [],
  environment: [],
  modules: stages.map((stage, index) => ({
    id: stage,
    title: stage,
    version: "1.0.0",
    skill: `modules/${stage}/SKILL.md`,
    inputs: index ? [{ artifactId: stages[index - 1], contract: `${stages[index - 1]}/v1` }] : [],
    outputs: [{ id: stage, path: `${stage}.json`, contract: `${stage}/v1` }],
    checks: [
      {
        id: `${stage}-schema`,
        kind: "json-schema" as const,
        artifactId: stage,
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["stage", "predecessor"],
          properties: {
            stage: { const: stage },
            predecessor: { const: index ? stages[index - 1] : "none" }
          }
        }
      }
    ],
    approval: "human" as const,
    resultApproval: "human" as const
  }))
}
const files = stages.map((stage) => ({
  path: `modules/${stage}/SKILL.md`,
  bytes: Buffer.from(
    `---\nname: ${packageId}-${stage}\ndescription: Verify the current stage handoff using small local JSON.\n---\nRead this actual Skill and the declared upstream JSON, write ${stage}.json through the original tool, read it back, then finish. Never run processes or network.\n`
  )
}))
const compiled = compileNativeComposition(source, { files, actionCatalog: [] })
const zip = new AdmZip()
for (const file of compiled.files) zip.addFile(file.path, file.bytes)
const archive = zip.toBuffer()
const calls = new Map<string, { stage: string; name: string; path: string }>()
const requests: Array<{ stage: string; tool?: string; inputBytes: number }> = []
const toolApprovals: Array<{
  requestId: string
  toolCallId: string
  path: string
  sha256: string
}> = []
const errors: string[] = []
let app: ElectronApplication | undefined
let page: Page | undefined

const server = createServer(async (request, response) => {
  try {
    assert.equal(request.method, "POST")
    assert.equal(request.url, "/v1/chat/completions")
    const chunks: Buffer[] = []
    let bytes = 0
    for await (const chunk of request) {
      bytes += chunk.length
      assert(bytes <= 2 * 1024 * 1024)
      chunks.push(Buffer.from(chunk))
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      model: string
      messages: Array<{ role: string; content: unknown; tool_call_id?: string }>
    }
    assert.equal(body.model, "original-feature-controlled")
    assert(requests.length < 24, "ORIGINAL_COMPLETION_REQUEST_LIMIT")
    const text = body.messages
      .map((message) =>
        typeof message.content === "string" ? message.content : JSON.stringify(message.content)
      )
      .join("\n")
    const stage = stages.find((value) => text.includes(`"stageId":"${value}"`))
    assert(stage, "ORIGINAL_COMPLETION_REAL_STAGE_CONTEXT_REQUIRED")
    const index = stages.indexOf(stage)
    const previous = index ? stages[index - 1] : undefined
    const skillBlock = text.match(
      /<CMBDEVCLAW-SKILL-USE-V1>[\s\S]*?<\/CMBDEVCLAW-SKILL-USE-V1>/
    )?.[0]
    const encoded = skillBlock?.match(/<path>([^<]+)<\/path>/)?.[1]
    assert(encoded, "ORIGINAL_COMPLETION_REAL_SKILL_CONTEXT_REQUIRED")
    const skill = encoded.replaceAll("&gt;", ">").replaceAll("&lt;", "<").replaceAll("&amp;", "&")
    const workspace = /The workspace root is: ([^\r\n]+)/
      .exec(text)?.[1]
      ?.trim()
      .replace(/^`|`$/g, "")
    assert(workspace && isAbsolute(workspace), "ORIGINAL_COMPLETION_REAL_WORKSPACE_REQUIRED")
    const within = relative(realpathSync(fixture.isolated), realpathSync(workspace))
    assert(within && !isAbsolute(within) && !within.startsWith(".."))
    const resultFor = (name: string, path: string) =>
      body.messages.find((message) => {
        const call = message.tool_call_id && calls.get(message.tool_call_id)
        return (
          message.role === "tool" &&
          call &&
          call.stage === stage &&
          call.name === name &&
          call.path === path
        )
      })
    const output = join(workspace, `${stage}.json`)
    let name: string | undefined
    let path = ""
    if (!resultFor("read_file", skill)) {
      name = "read_file"
      path = skill
    } else if (previous && !resultFor("read_file", join(workspace, `${previous}.json`))) {
      name = "read_file"
      path = join(workspace, `${previous}.json`)
    } else if (!resultFor("write_file", output)) {
      name = "write_file"
      path = output
    } else if (!resultFor("read_file", output)) {
      name = "read_file"
      path = output
    } else {
      assert(
        JSON.stringify(resultFor("read_file", skill)?.content).includes(`${packageId}-${stage}`)
      )
      assert(JSON.stringify(resultFor("read_file", output)?.content).includes(stage))
      if (previous)
        assert(
          JSON.stringify(
            resultFor("read_file", join(workspace, `${previous}.json`))?.content
          ).includes(previous)
        )
      assert.match(String(resultFor("write_file", output)?.content), /^Successfully wrote/)
    }
    const id = `original-completion-${requests.length}`
    if (name) calls.set(id, { stage, name, path })
    requests.push({ stage, tool: name, inputBytes: bytes })
    const delta = name
      ? {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id,
              type: "function",
              function: {
                name,
                arguments: JSON.stringify(
                  name === "write_file"
                    ? {
                        file_path: path,
                        content: JSON.stringify({ stage, predecessor: previous ?? "none" })
                      }
                    : { file_path: path }
                )
              }
            }
          ]
        }
      : { role: "assistant", content: `CONTROLLED_STAGE_DONE_${stage}` }
    response.writeHead(200, { "content-type": "text/event-stream" })
    response.write(
      `data: ${JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created: 1,
        model: body.model,
        choices: [{ index: 0, delta, finish_reason: null }]
      })}\n\n`
    )
    response.write(
      `data: ${JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created: 1,
        model: body.model,
        choices: [{ index: 0, delta: {}, finish_reason: name ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }
      })}\n\n`
    )
    response.end("data: [DONE]\n\n")
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error))
    if (!response.headersSent) response.writeHead(500)
    response.end("Controlled original Feature fixture rejected an unexpected request")
  }
})

async function main() {
  let result: Awaited<ReturnType<typeof exerciseLiveOriginalFeatureJourney>> | undefined
  let failure: string | undefined
  let forcedShutdown = false
  try {
    await new Promise<void>((done, fail) => {
      server.once("error", fail)
      server.listen(0, "127.0.0.1", done)
    })
    const address = server.address()
    assert(address && typeof address !== "string")
    app = await createHeadlessProjectCompositionLaunch(root, fixture, {
      unobtrusivePresentation: true
    })()
    app
      .process()
      .stdout?.on("data", (bytes) =>
        appendFileSync(join(fixture.isolated, "native-stdout.log"), bytes)
      )
    app
      .process()
      .stderr?.on("data", (bytes) =>
        appendFileSync(join(fixture.isolated, "native-stderr.log"), bytes)
      )
    page = await app.firstWindow()
    page.setDefaultTimeout(20_000)
    await page.addInitScript("window.__name = value => value")
    await page.evaluate("window.__name = value => value")
    await page.waitForFunction(() => Boolean(window.api?.harnessBoard))
    await page.addLocatorHandler(
      page.locator('[aria-label="应用使用指引"]').first(),
      async (guide) => guide.getByRole("button", { name: "跳过指引", exact: true }).click()
    )
    const setup = await page.evaluate(
      async ({ bytes, url, workspace }) => {
        await window.api.models.setCustomConfig({
          id: "original-feature-controlled",
          name: "隔离衔接测试",
          model: "original-feature-controlled",
          baseUrl: url,
          apiKey: "local-test-only",
          maxTokens: 128000,
          maxOutputTokens: 8192
        })
        await window.api.models.setDefault("custom:original-feature-controlled")
        await window.api.mods.configureGlobal(true)
        const thread = await window.api.threads.create({
          title: "原Feature衔接测试",
          workspacePath: workspace,
          agentMode: "normal"
        })
        const threadId = (thread as unknown as { thread_id: string }).thread_id
        await window.api.workspace.set(threadId, workspace)
        const installed = await window.api.plugins.install(
          new Uint8Array(bytes).buffer,
          "original-feature-handoff-fixture.zip",
          "local"
        )
        if (!installed.success || !installed.pluginId)
          throw Error(installed.error ?? "ORIGINAL_COMPLETION_INSTALL_FAILED")
        const plugin = (await window.api.plugins.list()).find(
          (value) => value.id === installed.pluginId
        )
        if (!plugin) throw Error("ORIGINAL_COMPLETION_PLUGIN_MISSING")
        const report = await window.api.plugins.prepareStartUse({
          threadId,
          expectedWorkspace: workspace,
          pluginId: plugin.id,
          expected: { name: plugin.name, version: plugin.version }
        })
        return { plugin, identity: report.identity }
      },
      {
        bytes: [...archive],
        url: `http://127.0.0.1:${address.port}/v1`,
        workspace: fixture.workspace
      }
    )
    const approved = new Set<string>()
    result = await exerciseLiveOriginalFeatureJourney({
      app,
      page,
      isolationRoot: fixture.isolated,
      workspaceParent: fixture.isolated,
      artifacts: fixture.isolated,
      installed: {
        pluginId: setup.plugin.id,
        name: setup.plugin.name,
        version: setup.plugin.version,
        sourceDigest: setup.identity.digest
      },
      project: {
        name: "Current source full handoff",
        code: `E2E${randomUUID().slice(0, 8)}`,
        systemId: "MODS-CONTROLLED",
        systemName: "Controlled acceptance",
        folder: "handoff"
      },
      feature: {
        title: "Implementation delivery audit",
        goal: "仅生成三个小JSON，验证代码阶段结束→交付→审计→最终完成的真实原流程衔接。不实现业务、不执行命令、不联网。"
      },
      deadline,
      execution: {
        providerBoundary: "controlled",
        maxStageTransitions: stages.length,
        confirmStage(view, operation) {
          assert.equal(view.project.manifest.actions.length, 0)
          return stages.includes(operation.stageId as (typeof stages)[number])
        },
        confirmKnownResult(view) {
          const stage = stages[view.project.stageIndex]
          const operation = view.operations.find(
            (value) => value.operationId === view.resultReview?.operationId
          )
          if (
            !stage ||
            operation?.status !== "succeeded" ||
            operation.execution?.terminal?.outcome !== "success" ||
            !operation.receipts.length ||
            !operation.receipts.every((receipt) => receipt.result === "passed")
          )
            return false
          const path = realpathSync(join(view.project.workspace, `${stage}.json`))
          assert.equal(relative(realpathSync(view.project.workspace), path), `${stage}.json`)
          assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
            stage,
            predecessor: view.project.stageIndex ? stages[view.project.stageIndex - 1] : "none"
          })
          return true
        },
        async decideKnownEnvironmentApprovals({ view, operation, pending }) {
          assert(operation.execution?.threadId)
          const threadId = operation.execution.threadId
          const workspace = realpathSync(view.project.workspace)
          for (const raw of pending) {
            const request = raw as ApprovalRequest
            assert(
              request.id &&
                request.tool_call.id &&
                request.operation === "write_file" &&
                request.filePath
            )
            assert(!request.retry_reason && request.allowed_approval_types.includes("approve"))
            const path = resolve(request.filePath)
            assert.equal(path, join(workspace, `${operation.stageId}.json`))
            const args = request.tool_call.args as { file_path: string; content: string }
            assert.equal(resolve(args.file_path), path)
            const index = stages.indexOf(operation.stageId as (typeof stages)[number])
            assert(index >= 0 && typeof args.content === "string")
            assert.deepEqual(JSON.parse(args.content), {
              stage: operation.stageId,
              predecessor: index ? stages[index - 1] : "none"
            })
            assert(!approved.has(request.id), "ORIGINAL_COMPLETION_DUPLICATE_APPROVAL")
            const still = await page!.evaluate(
              (id) => window.api.sandbox.getPendingApprovals(id),
              threadId
            )
            assert.deepEqual(
              still.find((value) => (value as ApprovalRequest).id === request.id),
              request
            )
            await page!.evaluate(
              (request) =>
                window.api.sandbox.sendApprovalDecision({
                  requestId: request.id,
                  tool_call_id: request.tool_call.id,
                  type: "approve"
                }),
              request
            )
            approved.add(request.id)
            toolApprovals.push({
              requestId: request.id,
              toolCallId: request.tool_call.id,
              path,
              sha256: createHash("sha256").update(args.content).digest("hex")
            })
          }
          const end = Date.now() + 10_000
          while (Date.now() < end) {
            const still = await page!.evaluate(
              (id) => window.api.sandbox.getPendingApprovals(id),
              threadId
            )
            if (!still.some((value) => approved.has((value as ApprovalRequest).id))) return true
            await new Promise((done) => setTimeout(done, 50))
          }
          return false
        }
      }
    })
    assert.deepEqual(result.environmentIssues, [])
    assert.deepEqual(result.pendingReviews, [])
    assert(!result.steps.some((step) => step.status !== "passed"))
    const final = await page.evaluate(
      ({ projectId, featureId }) => window.api.harnessBoard.getRunDetail(projectId!, featureId!),
      result
    )
    assert.equal(final.nativeProject?.project.status, "completed")
    assert.equal(final.nativeProject.project.stageIndex, stages.length)
    const transitioned = final.nativeProject.operations
      .filter((operation) => operation.status === "transitioned")
      .sort((left, right) => left.expectedVersion - right.expectedVersion)
    assert.deepEqual(
      transitioned.map((operation) => operation.stageId),
      stages
    )
    assert(
      transitioned.every(
        (operation) =>
          operation.execution?.terminal?.outcome === "success" &&
          operation.receipts.length > 0 &&
          operation.receipts.every((receipt) => receipt.result === "passed")
      )
    )
    assert.deepEqual(errors, [])
    for (const approval of toolApprovals)
      assert.equal(
        createHash("sha256").update(readFileSync(approval.path)).digest("hex"),
        approval.sha256,
        "ORIGINAL_COMPLETION_APPROVED_ARTIFACT_CHANGED"
      )
    for (const stage of stages)
      assert(requests.some((request) => request.stage === stage && !request.tool))
    console.log(
      JSON.stringify({
        originalFeature: "passed",
        stages,
        completed: true,
        requests: requests.length,
        approvals: approved.size,
        artifacts: fixture.isolated
      })
    )
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error)
    if (page)
      await page
        .screenshot({ path: join(fixture.isolated, "original-feature-controlled-failure.png") })
        .catch(() => {})
    throw error
  } finally {
    const timeout = setTimeout(() => {
      if (app && app.process().exitCode === null) {
        forcedShutdown = true
        app.process().kill()
      }
    }, 15000)
    if (page && result?.projectId && result.featureId) {
      await page
        .evaluate(async ({ projectId, featureId }) => {
          const view = await window.api.harnessBoard.getRunDetail(projectId!, featureId!)
          const running = view.nativeProject?.operations.find(
            (operation) => operation.status === "started"
          )
          if (running)
            await window.api.harnessBoard.nativeFeatureCommand(projectId!, featureId!, {
              kind: "cancel",
              operationId: running.operationId
            })
        }, result)
        .catch(() => {
          errors.push("ORIGINAL_COMPLETION_CANCEL_UNVERIFIED")
        })
    }
    try {
      await app?.close()
    } catch {
      errors.push("ORIGINAL_COMPLETION_CLOSE_FAILED")
    } finally {
      clearTimeout(timeout)
    }
    writeFileSync(
      join(fixture.isolated, "original-feature-controlled-evidence.json"),
      JSON.stringify(
        {
          candidate,
          provider: "controlled-loopback; no commercial model",
          manualFixture: true,
          package: { id: packageId, sha256: createHash("sha256").update(archive).digest("hex") },
          stages,
          result,
          requests,
          toolApprovals,
          errors,
          failure,
          forcedShutdown
        },
        null,
        2
      )
    )
    server.closeAllConnections()
    await new Promise<void>((done) => server.close(() => done()))
    assert(!forcedShutdown, "ORIGINAL_COMPLETION_SHUTDOWN_TIMEOUT")
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
