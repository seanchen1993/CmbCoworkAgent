/** Two real conversational authoring turns and native UI/tool execution, independent of projects. */
import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { basename, dirname, join, relative, resolve } from "node:path"
import type { ElectronApplication, Page } from "playwright"
import type { DevelopmentStatus } from "../src/shared/mods/development"
import { enterModsCreatorChat } from "./support/mods-sidebar-navigation"
import { genericModLiveRelay } from "./support/generic-mod-live-relay"
import { readGenericLiveSourceContinuation } from "./support/generic-live-source-continuation"
import {
  createHeadlessProjectCompositionLaunch,
  assertCreatorLiveCandidate,
  projectCompositionEnvironment
} from "./support/project-composition-e2e-fixtures"

const root = resolve(__dirname, "..")
assert.equal(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version, "2.0.0")
const build = assertCreatorLiveCandidate(root)
process.env.COMPOSITION_E2E_ARTIFACT_ROOT ??= join(root, "output/generic-mod-live-20261028")
const fixture = projectCompositionEnvironment(root)
const sourceContinuation = process.env.GENERIC_MOD_LIVE_REUSE_SOURCE_RUN
  ? readGenericLiveSourceContinuation(root, process.env.GENERIC_MOD_LIVE_REUSE_SOURCE_RUN)
  : undefined
const resumeProfile = process.env.GENERIC_MOD_LIVE_RESUME_PROFILE
assert(!(sourceContinuation && resumeProfile), "SOURCE_CONTINUATION_CANNOT_REUSE_OLD_PROFILE")
const feedbackPath = process.env.GENERIC_MOD_LIVE_FEEDBACK_EVIDENCE
const feedback = feedbackPath ? JSON.parse(readFileSync(feedbackPath, "utf8")) : undefined
if (feedback) {
  assert(sourceContinuation, "FEEDBACK_REQUIRES_VERIFIED_SOURCE_PROFILE")
  assert.equal(dirname(resolve(feedbackPath!)), sourceContinuation.profile)
  assert.match(basename(feedbackPath!), /^source-continuation-\d+\.json$/)
  assert.equal(feedback.error, "GENERIC_LIVE_TIMEOUT_COUNTER_INCREMENT")
  assert(
    feedback.requests.length > 0 &&
      feedback.requests.every((row: { status: number }) => row.status === 200)
  )
}
const label = process.env.GENERIC_MOD_LIVE_LABEL ?? ""
type RoundObservation = {
  round: number
  drafts: DevelopmentStatus["drafts"]
  trials: DevelopmentStatus["trials"]
  before?: number
  after?: number
  text?: string
  nativeReadCount?: number
  nativeReadReceipt?: { messageId: string; toolCallId?: string }
  paint?: {
    jobId: string
    sdkQueryObserved: true
    originalText: string
    textUnchanged: true
    cursorUnchanged: true
    virtualTextVisible: true
  }
}
let prior:
  | {
      threadId: string
      observations: RoundObservation[]
      diagnostic?: { status?: DevelopmentStatus }
    }
  | undefined
if (sourceContinuation) {
  const profile = sourceContinuation.profile
  prior = JSON.parse(readFileSync(sourceContinuation.evidencePath, "utf8"))
  for (const [key, value] of Object.entries(fixture.env))
    if (value.startsWith(fixture.isolated))
      fixture.env[key] = join(profile, relative(fixture.isolated, value))
  fixture.isolated = profile
  fixture.workspace = join(profile, "workspace")
  fixture.artifactRoot = dirname(profile)
}
if (resumeProfile) {
  const profile = resolve(resumeProfile)
  assert.equal(dirname(profile), fixture.artifactRoot)
  assert(/^run-[A-Za-z0-9]+$/.test(basename(profile)))
  assert(/^[a-z0-9-]+$/.test(label), "Resume evidence requires a unique label")
  prior = JSON.parse(readFileSync(join(profile, "evidence.json"), "utf8"))
  assert.equal(prior!.observations.length, 1)
  assert.equal(prior!.observations[0].nativeReadCount, 1)
  for (const [key, value] of Object.entries(fixture.env))
    if (value.startsWith(fixture.isolated))
      fixture.env[key] = join(profile, relative(fixture.isolated, value))
  fixture.isolated = profile
  fixture.workspace = join(profile, "workspace")
}
const artifactDirectory = sourceContinuation
  ? join(fixture.isolated, `continuation-${randomUUID()}`)
  : fixture.isolated
if (sourceContinuation) mkdirSync(artifactDirectory)
const evidencePath = join(
  artifactDirectory,
  resumeProfile ? `continuation-${label}.json` : "evidence.json"
)
if (resumeProfile || sourceContinuation) writeFileSync(evidencePath, "{}", { flag: "wx" })
const originalEvidenceDigest =
  sourceContinuation &&
  createHash("sha256").update(readFileSync(sourceContinuation.evidencePath)).digest("hex")
const protectedPictures =
  sourceContinuation &&
  Object.fromEntries(
    readdirSync(fixture.isolated)
      .filter((name) => /^(?:round-\d+.*|failure)\.png$/.test(name))
      .map((name) => [
        name,
        createHash("sha256")
          .update(readFileSync(join(fixture.isolated, name)))
          .digest("hex")
      ])
  )
fixture.env.CMB_MODS_E2E = "0"
const relay = genericModLiveRelay()
const observations: Array<{
  round: number
  drafts: DevelopmentStatus["drafts"]
  trials: DevelopmentStatus["trials"]
  before?: number
  after?: number
  text?: string
  nativeReadCount?: number
  nativeReadReceipt?: { messageId: string; toolCallId?: string }
  sourceFiles?: Array<{ path: string; sha256: string }>
  activeTrials?: DevelopmentStatus["trials"]
  paint?: RoundObservation["paint"]
}> = []
if (feedback) {
  const verified = feedback.observations.filter(
    (row: RoundObservation) =>
      row.round === 1 &&
      row.drafts[0]?.digest === sourceContinuation!.sourceDigest &&
      row.nativeReadCount === 1 &&
      row.paint?.jobId
  )
  assert.equal(verified.length, 1, "FEEDBACK_REQUIRES_PREVIOUS_NATIVE_PAINT_AND_READ")
  observations.push(verified[0])
} else if (resumeProfile && prior) observations.push(prior.observations[0])
const feedbackDigest =
  feedbackPath && createHash("sha256").update(readFileSync(feedbackPath)).digest("hex")
let app: ElectronApplication | undefined, page: Page | undefined
let threadId = "",
  passed = false,
  error: string | undefined
let diagnostic: unknown
let retained:
  | {
      draftId: string
      revision: number
      digest: string
      firstReadReceipt?: { messageId: string; toolCallId?: string }
    }
  | undefined
const deadline = Date.now() + 900_000
const pause = () => new Promise((done) => setTimeout(done, 250))
const save = () =>
  writeFileSync(
    evidencePath,
    JSON.stringify(
      {
        passed,
        error,
        threadId,
        build,
        ...(resumeProfile
          ? { restarted: true, priorEvidence: join(fixture.isolated, "evidence.json") }
          : {}),
        realAuthoring: true,
        model: relay.model,
        sourceContinuation: sourceContinuation && {
          evidence: sourceContinuation.evidencePath,
          sourceDigest: sourceContinuation.sourceDigest,
          oldAuthorityCopied: false,
          mode: "verified-real-model-source-in-same-owned-profile",
          consentBoundary: "native-confirmation-or-native-same-scope-reuse"
        },
        realRuntimeModel: true,
        ...(feedbackPath ? { feedbackFrom: feedbackPath, rerunFirstRound: false } : {}),
        observations,
        retained,
        diagnostic,
        requests: relay.metrics
      },
      null,
      2
    )
  )
async function until<T>(
  label: string,
  read: () => Promise<T | undefined>,
  limit = 90_000
): Promise<T> {
  const end = Math.min(deadline, Date.now() + limit)
  while (Date.now() < end) {
    assert(!relay.failure(), relay.failure())
    const value = await read()
    if (value !== undefined) return value
    await pause()
  }
  throw Error(`GENERIC_LIVE_TIMEOUT_${label}`)
}
const panel = () => page!.getByRole("dialog", { name: "插件创作工作区", exact: true })
async function closePanel() {
  if (await panel().isVisible())
    await panel().getByRole("button", { name: "Close", exact: true }).click()
}
async function send(prompt: string) {
  await closePanel()
  await page!.locator("textarea.composer-textarea").fill(prompt)
  await page!.getByRole("button", { name: "发送消息", exact: true }).click()
}
async function idle() {
  let idleAt = 0
  await until(
    "IDLE",
    async () => {
      const busy = await page!
        .getByRole("button", {
          name: /停止生成|停止响应|停止运行/,
          includeHidden: true
        })
        .count()
      if (busy || relay.inFlight()) idleAt = 0
      else idleAt ||= Date.now()
      return idleAt && Date.now() - idleAt >= 1500 ? true : undefined
    },
    420_000
  )
}
async function status() {
  return page!.evaluate((id) => window.api.mods.development.status({ threadId: id }), threadId)
}
async function author(round: number, prompt: string, allowRetained = false) {
  relay.phase(`author-${round}`)
  const prior = (await status()).drafts.map((draft) => draft.digest)
  await send(prompt)
  await until(
    "AUTHOR_CANDIDATE",
    async () => {
      const approvals = await page!.evaluate(
        (id) => window.api.sandbox.getPendingApprovals(id),
        threadId
      )
      assert.equal(
        approvals.length,
        0,
        "Authoring must use native draft tools, without command approvals"
      )
      const value = await status()
      return value.trials.some(
        (trial) =>
          ["needs-approval", "active"].includes(trial.phase) &&
          value.drafts.some(
            (draft) =>
              (allowRetained || !prior.includes(draft.digest)) &&
              draft.id === trial.draftId &&
              draft.revision === trial.revision &&
              draft.digest === trial.bundleDigest
          )
      )
        ? value
        : undefined
    },
    420_000
  )
  await idle()
  const value = await status()
  assert(value.trials.some((trial) => ["needs-approval", "active"].includes(trial.phase)))
  observations.push({ round, drafts: value.drafts, trials: value.trials })
  const draft = value.drafts[0]
  const transcript = await page!.evaluate((id) => window.api.threads.getMessages(id), threadId)
  const documents = transcript.flatMap((row) => {
    if (row.role !== "tool" || typeof row.content !== "string") return []
    try {
      const result = JSON.parse(row.content).result
      const document = result?.document ?? result
      return document?.source?.files &&
        document.id === draft.id &&
        document.revision === draft.revision &&
        document.source.digest === draft.digest
        ? [document]
        : []
    } catch {
      return []
    }
  })
  const document = documents.at(-1)
  assert(document, "Exact source must come from an actual native authoring tool result")
  assert.equal(document.source.digest, draft.digest)
  observations.at(-1)!.sourceFiles = document.source.files.map(
    (file: { path: string; text: string }) => ({
      path: file.path,
      sha256: createHash("sha256").update(file.text).digest("hex")
    })
  )
  if (resumeProfile)
    assert.equal(
      draft.digest,
      retained!.digest,
      "Resume must preserve the actual authored revision"
    )
  save()
}
async function activate() {
  const latest = observations.at(-1)!
  assert.equal(latest.drafts.length, 1)
  const draft = latest.drafts[0]
  const current = (await status()).trials.filter(
    (trial) =>
      trial.draftId === draft.id &&
      trial.revision === draft.revision &&
      trial.bundleDigest === draft.digest
  )
  assert.equal(current.length, 1, "Only the exact new candidate may be approved")
  const expected = current[0]
  const chat = page!.locator(`[data-chat-thread-id=${JSON.stringify(threadId)}]`)
  if (expected.phase === "needs-approval") {
    if (!(await panel().isVisible())) await chat.locator('[data-app-guide="workspace"]').click()
    await panel().getByRole("button", { name: "确认并开始聊天试用", exact: true }).click()
  } else
    assert.equal(
      expected.phase,
      "active",
      "Unchanged capabilities may reuse the prior native approval"
    )
  await until("ACTIVE", async () => {
    const value = await status()
    const trial = value.trials.find(
      (trial) =>
        trial.componentId === expected.componentId &&
        trial.draftId === expected.draftId &&
        trial.revision === expected.revision &&
        trial.bundleDigest === expected.bundleDigest
    )
    assert(!trial || !["failed", "unknown"].includes(trial.phase), trial?.error)
    return trial?.phase === "active" ? true : undefined
  })
  await closePanel()
  await chat.getByRole("button", { name: "普通模式", exact: true }).click()
}
async function display() {
  const site = page!
    .locator(`[data-chat-thread-id=${JSON.stringify(threadId)}]`)
    .locator('[data-function-site="AbovePrompt"]:visible')
    .first()
  if (!(await site.count())) return undefined
  const text = await site.innerText()
  const match = /工具调用次数[：:]\s*(\d+)/.exec(text)
  return match ? { count: Number(match[1]), text } : undefined
}
async function trigger(round: number) {
  relay.phase(`trigger-${round}`)
  const observation = observations.at(-1)!
  observation.before = (await until("DISPLAY", display, 30_000)).count
  const file = `${sourceContinuation ? basename(artifactDirectory) + "-" : ""}generic-trigger-${round}.txt`,
    marker = `GENERIC_NATIVE_READ_${round}`
  writeFileSync(join(fixture.workspace, file), `${marker}\n`)
  const beforeMessages = await page!.evaluate((id) => window.api.threads.getMessages(id), threadId)
  const oldIds = new Set(beforeMessages.map((message) => message.id))
  await send(
    `请只用 read_file 工具读取当前工作区的 ${file} 一次，不用其他工具。读完原样回复其中的标记。`
  )
  await until("NATIVE_READ", async () => {
    const rows = await page!.evaluate((id) => window.api.threads.getMessages(id), threadId)
    return rows.some(
      (message) =>
        !oldIds.has(message.id) &&
        message.role === "tool" &&
        JSON.stringify(message.content).includes(marker)
    )
      ? true
      : undefined
  })
  await idle()
  const messages = await page!.evaluate((id) => window.api.threads.getMessages(id), threadId)
  const fresh = messages.filter((message) => !oldIds.has(message.id))
  const calls = fresh.flatMap((message) => message.tool_calls ?? [])
  assert.equal(calls.length, 1, "Runtime must execute exactly one native tool")
  assert.equal(calls[0].name, "read_file")
  assert(
    fresh.some(
      (message) => message.role === "tool" && JSON.stringify(message.content).includes(marker)
    ),
    "Actual native read must return the newly created marker"
  )
  const result = await until(
    "COUNTER_INCREMENT",
    async () => {
      const value = await display()
      return value?.count === observation.before! + 1 &&
        (round === 1 || /最近工具[：:]\s*read_file/.test(value.text))
        ? value
        : undefined
    },
    30_000
  )
  observation.after = result.count
  observation.text = result.text
  observation.nativeReadCount = calls.length
  const receipt = fresh.find(
    (message) => message.role === "tool" && JSON.stringify(message.content).includes(marker)
  )!
  observation.nativeReadReceipt = { messageId: receipt.id, toolCallId: receipt.tool_call_id }
  observation.activeTrials = (await status()).trials
  save()
  await page!.screenshot({
    path: join(artifactDirectory, `${label ? label + "-" : ""}round-${round}-verified.png`)
  })
}
async function verifyPaint(round: number) {
  relay.phase(`paint-${round}`)
  assert(
    relay.metrics.some((metric) =>
      metric.tools.some((tool) => tool.action === "catalog" && tool.sdkQuery === "prompt.paint")
    ),
    "REAL_AUTHOR_MUST_QUERY_NEW_PROMPT_PAINT_SDK"
  )
  const chat = page!.locator(`[data-chat-thread-id=${JSON.stringify(threadId)}]`)
  const composer = chat.locator("textarea.composer-textarea")
  const text = "TODO 核对一条资料"
  await composer.fill(text)
  const before = await composer.evaluate((node) => ({
    start: (node as HTMLTextAreaElement).selectionStart,
    end: (node as HTMLTextAreaElement).selectionEnd
  }))
  const descriptor = (await page!.evaluate((id) => window.api.mods.commands(id), threadId)).find(
    (command) => command.command === "paint-note"
  )
  // Trial commands deliberately retain the physical queue even when authored as immediate.
  assert(descriptor, "REAL_AUTHOR_PAINT_COMMAND_REQUIRED")
  const queued = await page!.evaluate(
    ({ id, descriptor }) => window.api.mods.enqueue(id, descriptor, { text: "" }),
    { id: threadId, descriptor }
  )
  await until("PAINT_JOB", async () => {
    const job = (await page!.evaluate((id) => window.api.mods.jobs(id), threadId)).find(
      (job) => job.id === queued.id
    )
    assert(!job || !["failed", "unknown", "cancelled"].includes(job.state), JSON.stringify(job))
    return job?.state === "succeeded" ? job : undefined
  })
  await chat.locator("[data-prompt-virtual]").filter({ hasText: "待核对" }).waitFor()
  assert.equal(await composer.inputValue(), text, "PAINT_CANNOT_REWRITE_DRAFT")
  const after = await composer.evaluate((node) => ({
    start: (node as HTMLTextAreaElement).selectionStart,
    end: (node as HTMLTextAreaElement).selectionEnd
  }))
  assert.deepEqual(after, before, "PAINT_CANNOT_MOVE_CURSOR")
  observations.at(-1)!.paint = {
    jobId: queued.id,
    sdkQueryObserved: true,
    originalText: text,
    textUnchanged: true,
    cursorUnchanged: true,
    virtualTextVisible: true
  }
  save()
  await page!.screenshot({ path: join(artifactDirectory, `round-${round}-paint-verified.png`) })
  await composer.fill("")
}
async function main() {
  const watchdog = setTimeout(() => {
    error = "GENERIC_LIVE_TOTAL_TIMEOUT"
    void app?.close()
  }, 900_000)
  try {
    const modelUrl = await relay.listen()
    app = await createHeadlessProjectCompositionLaunch(root, fixture, {
      unobtrusivePresentation: true
    })()
    app
      .process()
      .stderr?.on("data", (bytes: Buffer) =>
        appendFileSync(
          join(artifactDirectory, "electron-stderr.log"),
          relay.redact(bytes.toString("utf8"))
        )
      )
    page = await app.firstWindow({ timeout: 60_000 })
    page.setDefaultTimeout(20_000)
    await page.addInitScript("window.__name = value => value")
    await page.evaluate("window.__name = value => value")
    await page.waitForFunction(() => Boolean(window.api?.mods?.development))
    await page.addLocatorHandler(
      page.locator('[aria-label="插件创作使用指引"], [aria-label="应用使用指引"]').first(),
      async (guide) => guide.getByRole("button", { name: "跳过指引", exact: true }).click()
    )
    threadId = await page.evaluate(
      async ({ modelUrl, model, workspace, existingThreadId }) => {
        await window.api.autoCommit.saveSettings({ mode: "off", push: false })
        await window.api.models.setCustomConfig({
          id: "generic-live-relay",
          name: "真实模型隔离转发",
          baseUrl: modelUrl,
          model,
          apiKey: "localhost-dummy-only",
          maxTokens: 128000,
          maxOutputTokens: 8192,
          enableThinking: false
        })
        await window.api.models.setDefault("custom:generic-live-relay")
        if (existingThreadId) return existingThreadId
        const thread = await window.api.threads.create({
          title: "通用 Mod · 对话创建与修改",
          workspacePath: workspace,
          agentMode: "normal"
        })
        await window.api.workspace.set(thread.thread_id, workspace)
        return thread.thread_id
      },
      {
        modelUrl,
        model: relay.model,
        workspace: fixture.workspace,
        existingThreadId: prior?.threadId
      }
    )
    await page.reload()
    await page.waitForFunction(() => Boolean(window.api?.mods?.development))
    await page.evaluate("window.__name = value => value")
    await closePanel()
    await page.getByRole("tab", { name: "对话模式", exact: true }).click()
    const chat = page.locator(`[data-chat-thread-id=${JSON.stringify(threadId)}]`)
    if (!(await chat.isVisible()))
      await page.getByText("通用 Mod · 对话创建与修改", { exact: true }).first().click()
    await enterModsCreatorChat(page, threadId, fixture.workspace)
    if (feedback) {
      const current = await status()
      const expected = feedback.observations.at(-1).drafts[0]
      assert.equal(current.drafts.length, 1)
      assert.equal(current.drafts[0].id, expected.id)
      assert.equal(current.drafts[0].revision, expected.revision)
      assert.equal(current.drafts[0].digest, expected.digest)
    }
    if (resumeProfile) {
      const current = await status()
      assert.equal(current.drafts.length, 1)
      const draft = current.drafts[0]
      assert.equal(
        draft.digest,
        prior?.diagnostic?.status?.drafts[0]?.digest,
        "Resume must inspect the original conversation's already active updated source"
      )
      const rows = await page.evaluate((id) => window.api.threads.getMessages(id), threadId)
      const receipt = rows.find(
        (row) =>
          row.role === "tool" && JSON.stringify(row.content).includes("GENERIC_NATIVE_READ_1")
      )
      assert(receipt, "Original native first-read receipt must remain present")
      retained = {
        draftId: draft.id,
        revision: draft.revision,
        digest: draft.digest,
        firstReadReceipt: { messageId: receipt.id, toolCallId: receipt.tool_call_id }
      }
    }
    if (!resumeProfile && !feedback) {
      if (sourceContinuation) {
        const current = await status()
        assert.equal(current.drafts.length, 1, "CONTINUATION_EXACT_RETAINED_DRAFT_REQUIRED")
        assert.equal(current.drafts[0].id, sourceContinuation.id)
        assert.equal(current.drafts[0].digest, sourceContinuation.sourceDigest)
        assert.equal(current.drafts[0].revision, sourceContinuation.revision)
        await author(
          1,
          `应用已重启，继续验收同一已保存的真实模型源码，不重新创作。先定向查询prompt.paint签名，然后使用mod_authoring.read读取现有草稿id=${sourceContinuation.id}，revision=${sourceContinuation.revision}，sourceDigest=${sourceContinuation.sourceDigest}。保留源文件一字节不改，不调用save/submit、不另建、不生成替代代码。只检查并用request_trial准备当前版本的新隔离试用候选，然后结束本轮。不执行、不安装、不代我授权；本轮由我重新确认原生试用。`,
          true
        )
        assert.equal(
          observations[0].drafts[0].digest,
          sourceContinuation.sourceDigest,
          "CONTINUATION_MODEL_CHANGED_ORIGINAL_SOURCE"
        )
        assert.equal(
          observations[0].trials[0].phase,
          "needs-approval",
          "CONTINUATION_FRESH_CONSENT_REQUIRED"
        )
      } else
        await author(
          1,
          "请制作一个通用的工具次数计数与输入框标记 Mod，独立于项目模式和业务插件。先用 catalog(query:prompt.paint)、catalog(query:prompt.read) 定向查询新公开方法签名，不猜接口。只在当前聊天每个 read_file 工具执行完成后累计一次，其他工具不计数，在输入框上方显示‘工具调用次数：N’，初始0。另外注册 immediate:true 的 paint-note 命令：执行时通过 prompt.read 取得原输入，以原 text 调用 prompt.paint，对开头TODO四个字符添加 bold:true 和 virtualText:待核对；没有TODO开头则返回明确未标记。这个命令只绘制，不更改正文和光标，不填入新文本，不调用 prompt.fill，不自动执行。命令返回实际 isPainted 结果。不访问文件，不执行命令进程，不调用模型。请使用原生创作工具生成、检查并准备本聊天可确认的隔离试用候选，不要代我批准或安装。"
        )
      await activate()
      await trigger(1)
      await verifyPaint(1)
      await enterModsCreatorChat(page, threadId, fixture.workspace)
    }
    await author(
      2,
      feedback
        ? "反馈刚才同一草稿rev2的真实试用结果：read_file确实执行并返回了结果，但计数仍0，最近工具显示Read。平台公开未过滤tool.call事件的event.tool是Read，read_file是兼容过滤别名；把原来带{tool:'read_file'}的计数逻辑改成未过滤且只比较read_file后失效了。请读取当前同一草稿，修复对真实Read/read_file名称的处理，确保read_file完成后计数+1且最近工具显示read_file，其他工具按实际名称显示；保留paint-note纯显示行为和其余所有功能、文件，不另建、不重新生成。检查并准备新修订候选，结束本轮让我重新确认，不安装不代授权。"
        : resumeProfile
          ? "应用刚才重启了，请读取并核对上次已保存的同一个 Mod 最新草稿，保留已实现的 read_file 计数和最近工具显示，不另建、不手工重写已正确源码。用原生创作工具重新检查并恢复当前确切版本的试用候选，交给我重新确认；不要代我批准或安装，也不要执行文件或命令。"
          : "请修改刚才的同一个 Mod，不另建：保留 paint-note 的 prompt.paint 纯显示行为与 read_file 完成后累计次数的能力以及‘工具调用次数：N’显示，并在后面增加‘最近工具：工具名称’；执行 read_file 后必须显示‘最近工具：read_file’。沿用当前草稿身份，准备新的可确认试用候选。不访问文件，不执行命令，不调用模型，不代我批准或安装。",
      !!resumeProfile
    )
    await activate()
    await trigger(2)
    if (!resumeProfile) await verifyPaint(2)
    assert.equal(observations[0].drafts[0].id, observations[1].drafts[0].id)
    assert.notEqual(observations[0].drafts[0].digest, observations[1].drafts[0].digest)
    passed = true
  } catch (cause) {
    error = relay.redact(cause instanceof Error ? cause.message : String(cause))
    if (page && threadId)
      diagnostic = await page
        .evaluate(
          async ({ id, workspace }) => ({
            status: await window.api.mods.development.status({ threadId: id }),
            displayCapability: await window.api.mods.chatDisplayCapability(id, workspace),
            sites: [...document.querySelectorAll('[data-function-site="AbovePrompt"]')].map(
              (site) => ({
                html: site.outerHTML.slice(0, 6000),
                chatId: site.closest("[data-chat-thread-id]")?.getAttribute("data-chat-thread-id"),
                rect: {
                  width: site.getBoundingClientRect().width,
                  height: site.getBoundingClientRect().height
                }
              })
            )
          }),
          { id: threadId, workspace: fixture.workspace }
        )
        .catch(() => ({ unavailable: true }))
    await page
      ?.screenshot({ path: join(artifactDirectory, `${label ? label + "-" : ""}failure.png`) })
      .catch(() => {})
  } finally {
    clearTimeout(watchdog)
    if (threadId)
      await page
        ?.evaluate((id) => window.api.agent.cancel(id, { cancelWorkers: true }), threadId)
        .catch(() => {})
    await app?.close().catch(() => {})
    await relay.close()
    if (sourceContinuation)
      assert.equal(
        createHash("sha256").update(readFileSync(sourceContinuation.evidencePath)).digest("hex"),
        originalEvidenceDigest,
        "CONTINUATION_ORIGINAL_EVIDENCE_CHANGED"
      )
    if (feedbackPath)
      assert.equal(
        createHash("sha256").update(readFileSync(feedbackPath)).digest("hex"),
        feedbackDigest,
        "FEEDBACK_ORIGINAL_EVIDENCE_CHANGED"
      )
    if (protectedPictures)
      for (const [name, digest] of Object.entries(protectedPictures))
        assert.equal(
          createHash("sha256")
            .update(readFileSync(join(fixture.isolated, name)))
            .digest("hex"),
          digest,
          "CONTINUATION_PREVIOUS_PICTURE_CHANGED"
        )
    save()
    console.log(JSON.stringify({ passed, error, evidence: evidencePath }))
    if (!passed) process.exitCode = 1
  }
}
void main()
