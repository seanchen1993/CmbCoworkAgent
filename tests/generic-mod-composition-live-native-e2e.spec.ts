/** Real model authors both independent Mods; public native runtime executes their composition. */
import assert from "node:assert/strict"
import { appendFileSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import type { ElectronApplication, Page } from "playwright"
import { enterModsCreatorChat } from "./support/mods-sidebar-navigation"
import { genericModLiveRelay } from "./support/generic-mod-live-relay"
import { genericModNativeJourney } from "./support/generic-mod-live-native-helpers"
import { verifyGenericCompositionRecovery } from "./support/generic-mod-composition-recovery"
import {
  genericCompositionNames, genericProviderPrompt, genericConsumerPrompt,
  genericProviderRevisionPrompt
} from "./support/generic-mod-composition-prompts"
import {
  createHeadlessProjectCompositionLaunch, projectCompositionCandidate,
  projectCompositionEnvironment
} from "./support/project-composition-e2e-fixtures"

const root = resolve(__dirname, "..")
assert.equal(process.env.CREATOR_E2E_BUILT_PREVIEW, "1")
assert.equal(process.env.COMPOSITION_E2E_PACKAGED_DIR, undefined)
assert.equal(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version, "2.0.0")
const build = projectCompositionCandidate(root)
assert.equal(build.sha256, process.env.CREATOR_E2E_EXPECTED_SHA256)
process.env.COMPOSITION_E2E_ARTIFACT_ROOT ??= join(root, "output/generic-mod-composition-20261028")
const fixture = projectCompositionEnvironment(root)
const resume = process.env.GENERIC_MOD_PAIR_RESUME_PROFILE
const previousEvidence = resume ? resolve(resume, "evidence.json") : undefined
const previous = previousEvidence ? JSON.parse(readFileSync(previousEvidence, "utf8")) : undefined
if (resume) {
  const owned = resolve(resume)
  assert.equal(dirname(owned), resolve(root, "output/generic-mod-composition-20261028"))
  assert.equal(previous.build.sha256,
    process.env.GENERIC_MOD_PAIR_RESUME_SHA256 ?? build.sha256)
  assert.match(previous.threadId, /^[a-f0-9-]{36}$/)
  const generated = fixture.isolated
  for (const key of Object.keys(fixture.env))
    if (fixture.env[key].startsWith(generated))
      fixture.env[key] = owned + fixture.env[key].slice(generated.length)
  fixture.isolated = owned
  fixture.workspace = join(owned, "workspace")
  fixture.artifactRoot = dirname(owned)
}
fixture.env.CMB_MODS_E2E = "0"
const relay = genericModLiveRelay()
let app: ElectronApplication | undefined, page: Page | undefined, threadId = ""
let passed = false, error: string | undefined
const observations: unknown[] = []
const evidencePath = join(fixture.isolated, resume ? `evidence-resume-${Date.now()}.json` : "evidence.json")
const save = () => writeFileSync(evidencePath, JSON.stringify({
  passed, error, build, threadId, realAuthoring: true, runtimeUsesModel: false,
  ...(previousEvidence ? { resumedFrom: previousEvidence } : {}),
  observations, requests: relay.metrics
}, null, 2))

async function main() {
  const deadline = Date.now() + 1_500_000
  const watchdog = setTimeout(() => { error = "GENERIC_PAIR_TOTAL_TIMEOUT"; void app?.close() },
    1_500_000)
  try {
    const modelUrl = await relay.listen()
    app = await createHeadlessProjectCompositionLaunch(root, fixture,
      { unobtrusivePresentation: true })()
    app.process().stderr?.on("data", (bytes: Buffer) => appendFileSync(
      join(fixture.isolated, "electron-stderr.log"), relay.redact(bytes.toString("utf8"))))
    page = await app.firstWindow({ timeout: 60_000 })
    page.setDefaultTimeout(20_000)
    await page.addInitScript("window.__name = value => value")
    await page.evaluate("window.__name = value => value")
    await page.waitForFunction(() => Boolean(window.api?.mods?.development))
    await page.addLocatorHandler(
      page.locator('[aria-label="插件创作使用指引"], [aria-label="应用使用指引"]').first(),
      async (guide) => guide.getByRole("button", { name: "跳过指引", exact: true }).click())
    threadId = await page.evaluate(async ({ modelUrl, model, workspace, existingThread }) => {
      await window.api.autoCommit.saveSettings({ mode: "off", push: false })
      await window.api.models.setCustomConfig({ id: "generic-pair-relay", name: "真实模型隔离转发",
        baseUrl: modelUrl, model, apiKey: "localhost-dummy-only", maxTokens: 128000,
        maxOutputTokens: 8192, enableThinking: false })
      await window.api.models.setDefault("custom:generic-pair-relay")
      if (existingThread) return existingThread
      const thread = await window.api.threads.create({ title: "通用 Mods · 组合与替换",
        workspacePath: workspace, agentMode: "normal" })
      await window.api.workspace.set(thread.thread_id, workspace)
      return thread.thread_id
    }, { modelUrl, model: relay.model, workspace: fixture.workspace,
      existingThread: previous?.threadId as string | undefined })
    await page.reload()
    await page.waitForFunction(() => Boolean(window.api?.mods?.development))
    await page.evaluate("window.__name = value => value")
    const retainedPanel = page.getByRole("dialog", { name: "插件创作工作区", exact: true })
    if (await retainedPanel.isVisible())
      await retainedPanel.getByRole("button", { name: "Close", exact: true }).click()
    await page.getByRole("tab", { name: "对话模式", exact: true }).click()
    const chat = page.locator(`[data-chat-thread-id=${JSON.stringify(threadId)}]`)
    if (!(await chat.isVisible()))
      await page.getByText("通用 Mods · 组合与替换", { exact: true }).first().click()
    const journey = genericModNativeJourney(page, threadId, fixture.workspace, relay, deadline)
    if (process.env.GENERIC_MOD_PAIR_RECOVERY_EVIDENCE) {
      const recovery = await verifyGenericCompositionRecovery(page, threadId, fixture.isolated,
        process.env.GENERIC_MOD_PAIR_RECOVERY_EVIDENCE, journey, relay.phase,
        () => ({ requests: relay.metrics.length, inFlight: relay.inFlight() }), (observation) => {
          observations.push(observation)
          save()
        })
      observations.push({ phase: "recovery-summary", ...recovery })
      passed = recovery.restored && recovery.ordinaryChatPassed
      return
    }
    const suffix = "请创建独立草稿，使用 request_trial 准备本聊天原生试用，结束本轮等待用户确认，不要自行安装或授权。"
    await enterModsCreatorChat(page, threadId, fixture.workspace)
    const initialDrafts = new Set((await journey.status()).drafts.map((draft) => draft.id))
    const first = resume ? await journey.status()
      : await journey.author("provider-v1", genericProviderPrompt + suffix)
    const newProviders = first.drafts.filter((draft) => resume
      ? draft.id === "text-normalizer" : !initialDrafts.has(draft.id))
    assert.equal(newProviders.length, 1, "The model must create one standalone provider draft")
    let provider = newProviders[0]
    let activateProvider = !resume
    if (resume && provider.revision === 1) {
      observations.push({ phase: "resumed-original-draft", draft: provider })
      save()
      const repaired = await journey.author("provider-v1-feedback",
        `请继续修改原草稿 id=${provider.id}。上一轮实际检查发现 normalizeText 仅折叠连续空白，没有按原需求去除首尾空白。请修复此问题，保留原公共能力、输入输出契约和 revision=v1。
验收例：输入两个空格+Alpha+换行+两个空格+BETA+两个空格，输出必须精确为 Alpha BETA，不能留下首尾空格。输入只有空白时输出空字符串。
请读取原草稿后通过正式工具修改、检查并 request_trial，结束本轮等待原生确认；不要修改平台或消费者。`)
      const current = repaired.drafts.find((draft) => draft.id === provider.id)
      assert(current && current.digest !== provider.digest)
      provider = current
      activateProvider = true
    }
    if (activateProvider) await journey.activate()
    const savedProvider = await journey.reuse(provider)
    const providerInstalled = (await page.evaluate((id) => window.api.mods.status(id), threadId))
      .functionMods!.find((mod) => mod.pluginId === savedProvider.reuse?.installationId)
    assert(providerInstalled?.digest && providerInstalled.state === "ready")
    observations.push({ phase: "provider-installed", draft: provider, reuse: savedProvider.reuse,
      installed: providerInstalled })
    save()
    await enterModsCreatorChat(page, threadId, fixture.workspace)
    const beforeConsumer = new Set((await journey.status()).drafts.map((draft) => draft.id))
    const consumerState = await journey.author("consumer", genericConsumerPrompt.replace(
      'ref.provider="text-normalizer"', `ref.provider=${JSON.stringify(providerInstalled.name)}`
    ) + suffix)
    const newConsumers = consumerState.drafts.filter((draft) => !beforeConsumer.has(draft.id))
    assert.equal(newConsumers.length, 1, "Composition must contain distinct authored Mods")
    const consumer = newConsumers[0]
    await journey.activate()
    const savedConsumer = await journey.reuse(consumer)
    observations.push({ phase: "consumer-installed", draft: consumer, reuse: savedConsumer.reuse })
    save()

    async function run(text: string, success = true) {
      const id = threadId
      const before = new Set((await page!.evaluate((id) => window.api.mods.jobs(id), id))
        .map((job) => job.id))
      const descriptor = (await page!.evaluate((id) => window.api.mods.commands(id), id))
        .find((command) => command.command === genericCompositionNames.command)
      assert(descriptor, "Only the actual registered consumer command may execute")
      await page!.evaluate(({ id, descriptor, text }) =>
        window.api.mods.enqueue(id, descriptor, { text }), { id, descriptor, text })
      return journey.until("COMPOSED_COMMAND", async () => {
        const job = (await page!.evaluate((id) => window.api.mods.jobs(id), id))
          .find((job) => !before.has(job.id) && job.command === genericCompositionNames.command)
        if (!job || ["queued", "running"].includes(job.state)) return undefined
        observations.push({ phase: success ? "run" : "revoked-run", input: text, job })
        save()
        assert.equal(job.state, success ? "succeeded" : "failed", JSON.stringify(job))
        return success ? JSON.parse(job.result?.text ?? "") as Record<string, unknown> : job
      })
    }
    assert.deepEqual(await run("  Alpha \n  BETA  "),
      { text: "Alpha BETA", revision: "v1", passed: true, reason: "ok" })
    assert.deepEqual(await run("  Hi  "),
      { text: "Hi", revision: "v1", passed: false, reason: "too-short" })
    await enterModsCreatorChat(page, threadId, fixture.workspace)
    const updated = await journey.author("provider-v2", genericProviderRevisionPrompt +
      `沿用 id=${provider.id}，这是已正式安装的同一插件更新。请check后只用request_reuse准备正式版本更新，不要request_trial创建同名临时来源，结束本轮等待用户确认。`)
    const providerV2 = updated.drafts.find((draft) => draft.id === provider.id)
    assert(providerV2 && providerV2.digest !== provider.digest)
    // Update the original formal installation through its native reuse transaction.
    // Activating a second same-name trial beside the formal provider would be a distinct
    // conflicting source, not an installation update. The reuse transaction retires it.
    const providerUpdate = await journey.reuse(providerV2)
    assert.equal(providerUpdate.reuse?.installationId, savedProvider.reuse?.installationId,
      "Updating a revision must retain the original formal installation identity")
    assert.deepEqual(await run("  Alpha \n  BETA  "),
      { text: "alpha beta", revision: "v2", passed: true, reason: "ok" })
    const finalStatus = await page.evaluate((id) => window.api.mods.status(id), threadId)
    const current = finalStatus.functionMods!
      .find((mod) => mod.pluginId === savedProvider.reuse?.installationId)
    assert(current?.digest)
    // Approval accepts installation ID, but revocation deliberately accepts runtime name.
    const revokeArgs = [threadId, current.name, finalStatus.workspace] satisfies
      Parameters<Window["api"]["mods"]["revokeFunction"]>
    await page.evaluate((args) => window.api.mods.revokeFunction(...args), revokeArgs)
    await run("  Alpha BETA  ", false)
    const approveArgs = [threadId, current.pluginId, current.digest, finalStatus.workspace] satisfies
      Parameters<Window["api"]["mods"]["approveFunction"]>
    await page.evaluate((args) => window.api.mods.approveFunction(...args), approveArgs)
    assert.deepEqual(await run("  Alpha BETA  "),
      { text: "alpha beta", revision: "v2", passed: true, reason: "ok" })
    observations.push({ phase: "final", status: await journey.status() })
    await journey.closePanel()
    await page.screenshot({ path: join(fixture.isolated, "composition-verified.png") })
    passed = true
  } catch (cause) {
    error = relay.redact(cause instanceof Error ? cause.message : String(cause))
    await page?.screenshot({ path: join(fixture.isolated, "failure.png") }).catch(() => {})
  } finally {
    clearTimeout(watchdog)
    if (threadId) await page?.evaluate((id) => window.api.agent.cancel(id,
      { cancelWorkers: true }), threadId).catch(() => {})
    await app?.close().catch(() => {})
    await relay.close()
    save()
    console.log(JSON.stringify({ passed, error, evidence: evidencePath }))
    if (!passed) process.exitCode = 1
  }
}
void main()
