/** Actual memory UI with the real durable Bot API. Only model text is a deterministic fixture. */
import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { build } from "esbuild"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"
import { chromium } from "playwright"
import { BotStore } from "../src/main/bots/store"
import { BotHost } from "../src/main/bots/host"
import { createBotAPI } from "../src/main/bots/rpc"
import { BotSkillCatalogSync } from "../src/main/bots/skill-catalog-sync"
import { BotSkillCatalogProcess } from "../src/main/bots/skill-catalog-process"
import { writeBotModelSnapshot } from "../src/main/bots/model-config"
import { BotMemorySynthesis } from "../src/main/bots/memory-synthesis"
import { startBotModelUsage, settleBotModelUsage } from "../src/main/bots/model-usage"
import { highlightWorkerFixture } from "./fixtures/highlight-worker"
import type { ModelResponseDiagnostic } from "../src/main/agent/model-response-diagnostics"

async function main() {
  const root = await mkdtemp(join(tmpdir(), "cmb-memory-ui-")),
    output = resolve("output/bot-memory")
  await mkdir(output, { recursive: true })
  let now = 1_800_000_000_000
  const store = new BotStore(join(root, "bots.sqlite"), () => now)
  const { bot, conversationId } = store.createBot({
    nonce: "bot",
    name: "项目助手",
    workspacePath: root
  })
  const sent = store.send({
    nonce: "message",
    conversationId,
    text: "星舟项目每周三做发布评审；文档和评审意见统一使用中文。"
  })
  const claim = store.claim("fixture")!
  store.finish(claim.lease, "succeeded", "已记录项目安排。")
  now += 16000
  let failMemory = false
  const service = new BotMemorySynthesis(store, async () => ({
    assertCurrent: async () => {},
    complete: async (system, data) =>
      failMemory
        ? "invalid"
        : JSON.stringify(
            system.includes("VERIFICATION")
              ? { approved: true }
              : {
                  changes: [
                    {
                      action: "create",
                      content:
                        (data as { newEvidence: { id: string }[] }).newEvidence[0].id ===
                        sent.runIds[0]
                          ? "星舟项目每周三进行发布评审，文档与评审意见使用中文。"
                          : "发布后需要归档验证记录。",
                      kind: "profile",
                      sourceEvidenceIds: [
                        (data as { newEvidence: { id: string }[] }).newEvidence[0].id
                      ]
                    }
                  ]
                }
          )
  }))
  await service.runNow()
  // UI fixtures use the real durable ledger/API; protocol metering is tested separately.
  const usageModel = {
    id: "memory-model",
    ref: "configured-memory",
    model: "Memory fixture",
    baseUrl: "http://unused.invalid"
  }
  for (const purpose of ["memory-synthesis", "memory-verification"] as const) {
    const id = startBotModelUsage(store, {
      botId: bot.id,
      model: usageModel,
      purpose,
      reserved: 8192
    })
    settleBotModelUsage(store, id, {
      doneEvents: 1,
      errorEvents: 0,
      uninspectedEvents: 0,
      inputTokens: 321,
      outputTokens: 19
    } as ModelResponseDiagnostic)
  }
  startBotModelUsage(store, {
    botId: bot.id,
    model: usageModel,
    purpose: "memory-synthesis",
    reserved: 8192
  })
  const otherBot = store.createBot({ nonce: "reviewer", name: "评审助手" }).bot
  const sharedSource = store.saveSkill({
    botId: bot.id,
    name: "发布评审",
    instructions: "1. 阅读变更与测试结果。\n2. 核对兼容性和回退步骤。\n3. 汇总证据，提交人工评审。",
    enabled: true
  })
  let losePublishResponse = true
  let loseMemoryRetryResponse = true
  const retryInputs: unknown[] = []
  const source = {
    builtinSkillsDir: join(root, "builtin"),
    customSkillsDir: join(root, "custom"),
    pluginsStorePath: join(root, "plugins.json"),
    disabledSkillsPath: join(root, "disabled.json"),
    disabledSkillsRevision: 0,
    globalRevision: 0
  }
  await mkdir(source.builtinSkillsDir)
  await mkdir(join(source.customSkillsDir, "release-check"), { recursive: true })
  const installedFile = join(source.customSkillsDir, "release-check", "SKILL.md")
  await writeFile(
    installedFile,
    "---\nname: 发布前检查\ncompatibility: 需要 Node.js 22 或更高版本\n---\n检查本次变更、验证结果和回退步骤，提交人工评审。"
  )
  await writeFile(
    join(source.customSkillsDir, "release-check", "check.cjs"),
    'console.log("review")'
  )
  await writeFile(source.pluginsStorePath, "[]")
  await writeFile(source.disabledSkillsPath, "[]")
  const modelFile = join(root, "models.private")
  await writeBotModelSnapshot(modelFile, {
    version: 1,
    defaultRef: null,
    models: [],
    skillSources: source
  })
  const catalog = new BotSkillCatalogSync(
    store,
    modelFile,
    new BotSkillCatalogProcess({
      entry: resolve("src/main/bots/skill-catalog-entry.ts"),
      execArgv: ["--import", "tsx"]
    })
  )
  await catalog.ensure()
  const api = createBotAPI(
      new BotHost(store, {
        execute: async () => {
          throw new Error("UI fixture must not call models")
        },
        refreshSkills: (force) => catalog.ensure(force ? 0 : 2000)
      })
    ),
    renderer = resolve("src/renderer/src")
  const css = await compile(
    (await readFile(join(renderer, "index.css"), "utf8")).replace(
      /^@import "@fontsource[^\n]+\n/gm,
      ""
    ),
    { base: renderer, onDependency: () => {} }
  )
  const scanner = new Scanner({
    sources: [{ base: renderer, pattern: "**/*.{ts,tsx}", negated: false }]
  })
  const bundle = await build({
    stdin: {
      contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {BotResources} from './src/renderer/src/components/bots/BotResources';import {BotApprovalContent} from './src/renderer/src/components/bots/BotApprovalContent';import {useBotWorkspaceStore} from './src/renderer/src/lib/bot-workspace-store';import {applyThemePreference} from './src/renderer/src/lib/theme-preference';
  window.fixtureTheme=applyThemePreference;applyThemePreference('codex-light');window.api={bots:new Proxy({}, {get:(_,method)=>(input)=>window.botCall(method,input)})};
  useBotWorkspaceStore.setState({host:${JSON.stringify(await api.status())},snapshot:${JSON.stringify(await api.snapshot())}});
  const root=createRoot(document.getElementById('root'));window.fixtureApproval=(prompt)=>root.render(<div className="mx-auto mt-16 max-w-md rounded-2xl border bg-card p-6 text-foreground"><BotApprovalContent prompt={prompt}/></div>);window.fixtureResources=(tab,bot)=>root.render(<BotResources key={bot.id+tab} bot={bot} tab={tab} manageSkills={()=>{window.managedSkills=true}} close={()=>{window.closed=true}}/>);window.fixtureResources('memory',${JSON.stringify(bot)});`,
      resolveDir: process.cwd(),
      loader: "tsx"
    },
    bundle: true,
    platform: "browser",
    format: "iife",
    write: false,
    outfile: join(root, "memory.js"),
    jsx: "automatic",
    alias: { "@": renderer },
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env.DEV": "false" },
    plugins: [await highlightWorkerFixture(renderer)]
  })
  const browser = await chromium.launch({
    channel: process.platform === "win32" ? "msedge" : "chrome",
    headless: true,
    args: ["--disable-updater-scheduler"]
  })
  const page = await browser.newPage({ viewport: { width: 1060, height: 820 } }),
    errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  page.setDefaultTimeout(10000)
  try {
    await page.exposeFunction("botCall", async (method: keyof typeof api, input: unknown) => {
      if (!Object.hasOwn(api, method)) throw new Error("Unknown API")
      if (method === "retryMemory") retryInputs.push(input)
      const result = await (api[method] as (input: unknown) => Promise<unknown>)(input)
      if (method === "retryMemory" && loseMemoryRetryResponse) {
        loseMemoryRetryResponse = false
        throw new Error("重试已受理，模拟回执丢失")
      }
      if (method === "publishSkill" && losePublishResponse) {
        losePublishResponse = false
        throw new Error("模拟响应丢失，请重试")
      }
      return result
    })
    await page.route("http://127.0.0.1:39176/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><html><head><meta charset="utf-8"><style>${css.build(scanner.scan())}\n${bundle.outputFiles
          .filter((file) => file.path.endsWith(".css"))
          .map((file) => file.text)
          .join(
            "\n"
          )}</style></head><body><div id="root"></div><script>${bundle.outputFiles.find((file) => file.path.endsWith(".js"))!.text.replaceAll("</script", "<\\/script")}</script></body></html>`
      })
    )
    await page.goto("http://127.0.0.1:39176")
    await page.getByText("自动整理 · 模型核验", { exact: true }).waitFor()
    const usageDetails = page.locator("summary").filter({ hasText: "近 30 天整理用量" })
    await usageDetails.click()
    await page.getByText(/已报告输入 642、输出 38 tokens/).waitFor()
    await page.getByText(/1 次尚无完整用量回执/).waitFor()
    assert.equal(await page.getByLabel("各模型已记录用量").locator("li").count(), 2)
    await page.screenshot({ path: join(output, "memory-usage-light.png"), animations: "disabled" })
    await page.evaluate("window.fixtureTheme('codex-dark')")
    await page.screenshot({ path: join(output, "memory-usage-dark.png"), animations: "disabled" })
    await page.evaluate("window.fixtureTheme('codex-light')")
    await usageDetails.click()
    await page.getByRole("button", { name: "1 条任务依据" }).click()
    await page
      .getByText("星舟项目每周三做发布评审；文档和评审意见统一使用中文。", { exact: true })
      .waitFor()
    await page.screenshot({
      path: join(output, "memory-evidence-light.png"),
      animations: "disabled"
    })
    await page.getByRole("button", { name: "编辑记忆", exact: true }).click()
    await page
      .getByRole("textbox", { name: "编辑记忆内容" })
      .fill("星舟项目改为每周四发布评审，文档使用中文。")
    await page.getByRole("button", { name: "保存修订", exact: true }).click()
    await page.getByText("显式记忆 · 自动整理不会修改", { exact: true }).waitFor()
    assert.equal(store.memories(bot.id)[0].text, "星舟项目改为每周四发布评审，文档使用中文。")
    assert.equal(store.memories(bot.id)[0].origin, "explicit")
    store.send({ nonce: "retry-evidence", conversationId, text: "发布后需要归档验证记录。" })
    const retryClaim = store.claim("memory-retry-fixture")!
    store.finish(retryClaim.lease, "succeeded", "已确认后续归档要求。")
    now += 16000
    failMemory = true
    for (let i = 0; i < 3; i++) {
      await service.runNow()
      now += 31000
    }
    await page.getByRole("button", { name: "重试整理", exact: true }).waitFor()
    await page.screenshot({
      path: join(output, "memory-retry-needed-light.png"),
      animations: "disabled"
    })
    await page.evaluate("window.fixtureTheme('codex-dark')")
    await page.waitForFunction(() => document.documentElement.classList.contains("dark"))
    await page.screenshot({
      path: join(output, "memory-retry-needed-dark.png"),
      animations: "disabled"
    })
    await page.evaluate("window.fixtureTheme('codex-light')")
    await page.getByRole("button", { name: "重试整理", exact: true }).click()
    await page.getByText("重试已受理，模拟回执丢失", { exact: true }).waitFor()
    assert.equal(store.memory.policy(bot.id).pending, 1)
    assert.equal(store.memory.policy(bot.id).revision, 1)
    // Leave/reopen while the accepted work completes; only the original receipt
    // may be acknowledged. It must not rerun the synthesis or show stale queued state.
    await page.evaluate(
      (value) =>
        (
          window as unknown as { fixtureResources: (tab: string, bot: unknown) => void }
        ).fixtureResources("skills", value),
      bot
    )
    failMemory = false
    await service.runNow()
    assert.equal(store.memory.policy(bot.id).pending, 0)
    await page.evaluate(
      (value) =>
        (
          window as unknown as { fixtureResources: (tab: string, bot: unknown) => void }
        ).fixtureResources("memory", value),
      bot
    )
    await page.getByRole("button", { name: "确认重试结果", exact: true }).click()
    await page.getByText("最近整理已完成", { exact: true }).waitFor()
    assert.equal(retryInputs.length, 2)
    assert.deepEqual(retryInputs[0], retryInputs[1])
    assert.equal(store.memory.policy(bot.id).revision, 1)
    assert.equal(store.memories(bot.id).length, 2)
    await page.screenshot({ path: join(output, "memory-retry-light.png"), animations: "disabled" })
    await page
      .getByRole("article", { name: "记忆条目" })
      .filter({ hasText: "发布后需要归档验证记录。" })
      .getByRole("button", { name: "删除记忆", exact: true })
      .click()
    await page.getByText("发布后需要归档验证记录。", { exact: true }).waitFor({ state: "hidden" })
    await page.getByRole("switch", { name: "自动整理任务经验" }).click()
    await page.locator('[role="switch"][aria-checked="false"]').waitFor()
    assert.equal(store.memory.policy(bot.id).enabled, false)
    await page.evaluate("window.fixtureTheme('codex-dark')")
    await page.waitForFunction(() => document.documentElement.classList.contains("dark"))
    await page.screenshot({ path: join(output, "memory-dark.png"), animations: "disabled" })
    await page.getByRole("button", { name: "删除记忆", exact: true }).click()
    await page
      .getByText("还没有记忆。可以添加长期偏好，或在完成任务后查看整理结果。", { exact: true })
      .waitFor()
    assert.equal(store.memories(bot.id).length, 0)
    await page.getByRole("tab", { name: "我的所有 Bot", exact: true }).click()
    await page
      .getByRole("textbox", { name: "添加共享记忆" })
      .fill("所有项目的评审意见使用中文，附验证依据。")
    await page.getByRole("button", { name: "保存共享记忆", exact: true }).click()
    await page.getByText("所有项目的评审意见使用中文，附验证依据。", { exact: true }).waitFor()
    const sharedAddress = { botId: bot.id, botRevision: bot.revision, scope: "user" as const }
    assert.equal((await api.sharedMemories(sharedAddress)).length, 1)
    await page.getByRole("tab", { name: "当前项目", exact: true }).click()
    await page
      .getByRole("textbox", { name: "添加共享记忆" })
      .fill("星舟项目统一使用 PostgreSQL，发布前检查兼容性。")
    await page.getByRole("button", { name: "保存共享记忆", exact: true }).click()
    await page
      .getByText("星舟项目统一使用 PostgreSQL，发布前检查兼容性。", { exact: true })
      .waitFor()
    assert.equal(
      await page.getByText("所有项目的评审意见使用中文，附验证依据。", { exact: true }).count(),
      0
    )
    await page.evaluate("window.fixtureTheme('codex-light')")
    await page
      .getByRole("article")
      .filter({ hasText: "星舟项目统一使用 PostgreSQL，发布前检查兼容性。" })
      .waitFor()
    assert.equal(await page.evaluate(() => document.compatMode), "CSS1Compat")
    await page.screenshot({
      path: join(output, "memory-project-light.png"),
      animations: "disabled"
    })
    await page.getByRole("button", { name: "编辑记忆", exact: true }).click()
    await page
      .getByRole("textbox", { name: "编辑记忆内容" })
      .fill("星舟项目使用 PostgreSQL 17，升级需评审。")
    await page.getByRole("button", { name: "保存修订", exact: true }).click()
    await page.getByText("星舟项目使用 PostgreSQL 17，升级需评审。", { exact: true }).waitFor()
    await page.getByRole("tab", { name: "我的所有 Bot", exact: true }).click()
    await page.getByText("所有项目的评审意见使用中文，附验证依据。", { exact: true }).waitFor()
    await page.evaluate("window.fixtureTheme('codex-dark')")
    await page.screenshot({ path: join(output, "memory-user-dark.png"), animations: "disabled" })
    await page.getByRole("button", { name: "删除记忆", exact: true }).click()
    assert.equal((await api.sharedMemories(sharedAddress)).length, 1)
    await page.getByRole("button", { name: "确认删除共享记忆", exact: true }).click()
    await page.getByText("此范围还没有共享记忆", { exact: true }).waitFor()
    assert.equal((await api.sharedMemories(sharedAddress)).length, 0)
    assert.equal((await api.sharedMemories({ ...sharedAddress, scope: "project" })).length, 1)
    await page.getByRole("tab", { name: "此 Bot", exact: true }).click()
    assert.equal(store.memories(bot.id).length, 0)

    await page.evaluate(`window.fixtureResources('skills',${JSON.stringify(bot)})`)
    await page.getByText("管理技能", { exact: true }).click()
    await page.getByRole("button", { name: "共享到我的技能库", exact: true }).click()
    assert.equal(store.skillLibrary.list().length, 0)
    await page
      .getByRole("group", { name: "确认共享技能" })
      .getByText("确认共享", { exact: true })
      .click()
    await page.getByRole("alert").filter({ hasText: "模拟响应丢失" }).waitFor()
    assert.equal(store.skillLibrary.list()[0].revision, 1)
    await page.getByRole("button", { name: "确认共享", exact: true }).click()
    await page.getByText("已共享源版本 1；后续修订需确认后更新。", { exact: true }).waitFor()
    assert.equal(store.skillLibrary.list()[0].revision, 1)
    const publishedId = store.skillLibrary.list()[0].id
    store.saveSkill({ ...sharedSource, instructions: "私有版本二，仅供当前项目使用。" })
    await page.evaluate(`window.fixtureResources('skills',${JSON.stringify(otherBot)})`)
    await page.getByRole("tab", { name: "我的技能库", exact: true }).click()
    const libraryCard = page.getByRole("article").filter({ hasText: "发布评审" })
    await libraryCard.getByText("查看技能步骤", { exact: true }).click()
    await libraryCard.getByText(sharedSource.instructions, { exact: true }).waitFor()
    assert.equal(await page.getByText("私有版本二，仅供当前项目使用。", { exact: true }).count(), 0)
    assert.equal(await page.getByRole("button", { name: "保存", exact: true }).count(), 0)
    assert(
      store.skillReferences
        .catalog({
          conversationId: store
            .snapshot()
            .conversations.find((item) => item.members.includes(otherBot.id))!.id
        })
        .some((item) => item.id === publishedId)
    )
    await page.evaluate("window.fixtureTheme('codex-light')")
    await page.screenshot({ path: join(output, "skill-library-light.png"), animations: "disabled" })
    await page.getByRole("button", { name: "撤回共享", exact: true }).click()
    assert.equal(store.skillLibrary.list()[0].enabled, true)
    await page.evaluate("window.fixtureTheme('codex-dark')")
    await page.screenshot({
      path: join(output, "skill-library-withdraw-dark.png"),
      animations: "disabled"
    })
    await page.getByRole("button", { name: "确认撤回", exact: true }).click()
    await page.getByText("暂无共享技能", { exact: true }).waitFor()
    assert.equal(
      store.skillLibrary.available(otherBot.id).some((item) => item.id === publishedId),
      false
    )
    assert.equal(store.skills(bot.id)[0].instructions, "私有版本二，仅供当前项目使用。")

    await page.getByRole("tab", { name: "CMBDevClaw 技能", exact: true }).click()
    await page.getByRole("button", { name: /发布前检查/ }).click()
    await page.getByText("查看技能步骤", { exact: true }).click()
    await page
      .getByText("检查本次变更、验证结果和回退步骤，提交人工评审。", { exact: true })
      .waitFor()
    await page.getByText("运行要求：需要 Node.js 22 或更高版本", { exact: true }).waitFor()
    await page.getByText(/包含 1 个附属文件/).waitFor()
    await page.getByRole("button", { name: "安装与管理", exact: true }).click()
    assert.equal(await page.evaluate("window.managedSkills"), true)
    await page.getByRole("textbox", { name: "搜索 CMBDevClaw 技能" }).fill("发布")
    await page.screenshot({
      path: join(output, "installed-skills-dark.png"),
      animations: "disabled"
    })
    await writeFile(installedFile, "---\nname: 发布前检查\n---\n新增兼容性检查，核对版本升级影响。")
    await page.getByRole("button", { name: "刷新 CMBDevClaw 技能", exact: true }).click()
    await page.getByRole("button", { name: /发布前检查.*v2/ }).waitFor()
    assert.equal(
      await page
        .getByText("检查本次变更、验证结果和回退步骤，提交人工评审。", { exact: true })
        .count(),
      0
    )
    await page.getByRole("button", { name: /发布前检查/ }).click()
    await page.getByText("查看技能步骤", { exact: true }).click()
    await page.getByText("新增兼容性检查，核对版本升级影响。", { exact: true }).waitFor()
    await writeFile(source.disabledSkillsPath, '["release-check"]')
    await page.getByRole("button", { name: "刷新 CMBDevClaw 技能", exact: true }).click()
    await page.getByText("没有匹配的可用技能", { exact: true }).waitFor()
    assert.equal(
      await page.getByText("新增兼容性检查，核对版本升级影响。", { exact: true }).count(),
      0
    )

    await page.evaluate(
      (prompt) =>
        (window as unknown as { fixtureApproval: (value: string) => void }).fixtureApproval(prompt),
      JSON.stringify({
        skillImport: {
          name: "发布前检查",
          path: "templates/release-report.docx",
          destination: "release-report.docx",
          root: "C:\\Projects\\Release",
          size: 24576,
          sha256: "a".repeat(64)
        }
      })
    )
    await page.getByText("复制技能模板到项目", { exact: true }).waitFor()
    await page
      .getByText("原样复制，不运行文件。目标已存在或技能源文件变化时，本次复制停止。", {
        exact: true
      })
      .waitFor()
    await page.screenshot({
      path: join(output, "skill-template-approval-dark.png"),
      animations: "disabled"
    })
    await page.evaluate(
      (prompt) =>
        (window as unknown as { fixtureApproval: (value: string) => void }).fixtureApproval(prompt),
      JSON.stringify({
        hook: {
          name: "发布前检查",
          event: "Stop",
          version: 3,
          type: "command",
          command: "node scripts/check-evidence.cjs",
          cwd: "C:\\Skills\\release-review",
          sandbox: "unelevated",
          inputPreview:
            '{"hook_event_name":"Stop","stop_context":{"assistantResponse":"测试完成，待检查发布证据。"}}',
          inputCharacters: 92
        }
      })
    )
    await page.getByText("运行技能检查 · 发布前检查", { exact: true }).waitFor()
    await page.getByText("任务交付前 · 第 3 版", { exact: true }).waitFor()
    await page.getByText(/^查看事件输入/).click()
    assert.match(await page.locator("details").innerText(), /assistantResponse/)
    await page.screenshot({
      path: join(output, "skill-hook-approval-dark.png"),
      animations: "disabled"
    })
    await page.evaluate(
      (prompt) =>
        (window as unknown as { fixtureApproval: (value: string) => void }).fixtureApproval(prompt),
      JSON.stringify({
        hook: {
          name: "项目 Hook",
          event: "PreToolUse",
          version: "b".repeat(64),
          type: "command",
          command: "node scripts/check-change.cjs",
          cwd: "C:\\Projects\\Release",
          sandbox: "none",
          inputPreview: '{"tool_name":"execute","tool_input":{"command":"npm test"}}',
          inputCharacters: 58
        }
      })
    )
    await page.getByText("运行检查 · 项目 Hook", { exact: true }).waitFor()
    await page.getByText("工具执行前 · 配置 bbbbbbbbbbbb", { exact: true }).waitFor()
    await page.getByText("执行目录：C:\\Projects\\Release", { exact: true }).waitFor()
    await page.screenshot({
      path: join(output, "configured-hook-approval-dark.png"),
      animations: "disabled"
    })
    assert.deepEqual(errors, [])
    await writeFile(
      join(output, "results.json"),
      JSON.stringify(
        {
          passed: [
            "evidence-source",
            "human-correction",
            "explicit-protection",
            "memory-retry-lost-receipt-reopen-no-duplicate",
            "disable-auto",
            "delete",
            "light-dark",
            "scope-tabs",
            "shared-create-edit-confirmed-delete",
            "project-user-separation",
            "skill-reviewed-publish-lost-response-retry",
            "skill-library-other-bot-private-version-isolation",
            "skill-confirmed-withdrawal",
            "installed-resource-count-and-compatibility",
            "skill-management-navigation",
            "binary-skill-import-approval"
          ],
          errors
        },
        null,
        2
      )
    )
    console.log("PASS: Bot memory and shared skill library UI")
  } catch (error) {
    console.error(await page.locator("body").innerText())
    await page.screenshot({ path: join(output, "failure.png") })
    throw error
  } finally {
    await browser.close()
    await catalog.close()
    await service.close()
    store.close()
    await rm(root, { recursive: true, force: true })
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
