import assert from "node:assert/strict"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { createRequire } from "node:module"
import { build } from "esbuild"
import { _electron } from "playwright"
import type { PartnerDevStatus, PartnerDevRunView } from "../../src/shared/bot/partner-dev"
import type { ExpertMemoryList } from "../../src/shared/bot/expert-memory"

/** Actual React component in Chromium, deterministic fake IPC for UI only.
 * Backend/actual graph acceptance is the separate partner-http-journey. */
async function main() {
  const root = process.cwd(),
    binary = createRequire(import.meta.url)("electron") as string,
    dir = await mkdtemp(join(tmpdir(), "devclaw-partner-panel-"))
  let electron: Awaited<ReturnType<typeof _electron.launch>> | undefined
  try {
    const bundle = await build({
      entryPoints: [resolve("tests/support/partner-dev-panel-fixture.tsx")],
      bundle: true,
      platform: "browser",
      format: "iife",
      write: false,
      jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"' },
      alias: { "@": join(root, "src/renderer/src") }
    })
    const html = join(dir, "index.html"),
      entry = join(dir, "main.cjs")
    await writeFile(
      html,
      '<meta charset="UTF-8"><style>body{font:14px system-ui;background:#fff;color:#161b25;margin:0}section{border:1px solid #ddd;border-radius:12px;padding:18px;margin:14px}header{padding:18px}input,textarea,button{font:inherit;padding:6px;margin:4px}svg{width:16px;height:16px}pre{white-space:pre-wrap}button:disabled{opacity:.4}</style><div id="root"></div>'
    )
    await writeFile(
      entry,
      `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(dir, "profile"))});app.whenReady().then(()=>{const window=new BrowserWindow({width:1200,height:1000,show:false,webPreferences:{backgroundThrottling:false}});window.loadFile(${JSON.stringify(html)})});`
    )
    const env: Record<string, string> = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined
      )
    )
    delete env.ELECTRON_RUN_AS_NODE
    electron = await _electron.launch({
      executablePath: binary,
      args: [entry],
      env,
      timeout: 30000
    })
    const page = await electron.firstWindow()
    page.setDefaultTimeout(10000)
    const errors: string[] = []
    page.on("pageerror", (e) => errors.push(e.message))
    await page.waitForURL(/index\.html$/)
    const status: PartnerDevStatus = {
      connectionMode: "local-default",
      configured: true,
      connected: true,
      nodeEnabled: false,
      model: "simulated",
      url: "http://127.0.0.1:32123",
      spaceId: "A",
      nodeId: "node",
      ownerPrincipalId: "owner",
      businessPrincipalId: "business",
      workspacePath: null,
      expertDataPath: null,
      expertName: null,
      expertMemoryAdopted: false,
      groupId: null,
      botId: null,
      lastError: null,
      activeRunId: null,
      lastRunId: null,
      lastTaskNumber: null
    }
    const memories: ExpertMemoryList = {
      botId: "expert-ui",
      revision: 0,
      memories: [],
      canManage: true
    }
    let denyMemory = false
    let analyses = 0,
      enables = 0,
      revocations = 0,
      prompts = 0,
      result: PartnerDevRunView = {
        runId: "run-ui",
        status: "waiting_node",
        version: 1,
        result: null
      }
    await page.exposeFunction(
      "partnerFixtureCall",
      async (method: string, value?: Record<string, unknown>) => {
        assert(
          ![
            "createTeam",
            "bindTeam",
            "authorizeTeam",
            "revokeTeam",
            "enableNode",
            "listMemories",
            "createMemory",
            "updateMemory",
            "disableMemory",
            "enableTeamMemory",
            "adoptExpertMemory"
          ].includes(method),
          "removed renderer operation: " + method
        )
        if (method === "getStatus") return structuredClone(status)
        if (method === "createExpert")
          Object.assign(status, {
            botId: "expert-ui",
            groupId: "internal-only",
            expertName: value!.name,
            expertMemoryAdopted: true,
            expertDataPath: "/private/experts/stable-id",
            workspacePath: "/private/experts/stable-id/runtime"
          })
        if (method === "listExpertMemories") {
          if (denyMemory) throw Error("FORBIDDEN")
          return structuredClone(memories)
        }
        if (method === "createExpertMemory") {
          memories.revision++
          memories.memories.push({
            id: "memory-ui",
            spaceId: "A",
            botId: "expert-ui",
            version: 1,
            text: String(value!.text),
            status: "active",
            source: { kind: "manual" },
            createdBy: "owner",
            updatedBy: "owner",
            createdAt: "2026-10-15T01:00:00Z",
            updatedAt: "2026-10-15T01:00:00Z"
          })
          return structuredClone(memories)
        }
        if (method === "updateExpertMemory" || method === "disableExpertMemory") {
          assert.equal(value!.expectedVersion, memories.memories[0].version)
          memories.revision++
          memories.memories[0].version++
          if (method === "disableExpertMemory") memories.memories[0].status = "disabled"
          else Object.assign(memories.memories[0], { text: value!.text, status: value!.status })
          return structuredClone(memories)
        }
        if (method === "startExpert") {
          enables++
          status.nodeEnabled = true
        }
        if (method === "stopNode") status.nodeEnabled = false
        if (method === "revokeLocalAuthorization") {
          revocations++
          status.nodeEnabled = false
        }
        if (method === "disconnect") {
          status.connected = false
          status.nodeEnabled = false
        }
        if (method === "connect") status.connected = true
        if (method === "sendMessage") {
          assert.equal(value!.mentioned, true)
          return {
            kind: "task",
            notice: "任务已保存",
            taskId: "task-ui",
            taskNumber: "TASK-1",
            taskVersion: 1
          }
        }
        if (method === "analyzeTask") {
          analyses++
          return { kind: "task", notice: "等待模拟结果", taskNumber: "TASK-1", runId: "run-ui" }
        }
        if (method === "inspectRun") return structuredClone(result)
        return structuredClone(status)
      }
    )
    await page.addScriptTag({
      content:
        "window.api={partnerDev:new Proxy({}, {get:(_t,key)=>(value)=>window.partnerFixtureCall(key,value)})}"
    })
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    await page.getByRole("button", { name: "创建专家", exact: true }).waitFor()
    assert.equal(await page.getByRole("button", { name: "连接服务", exact: true }).count(), 0)
    assert.equal(await page.getByTestId("partner-advanced").getAttribute("open"), null)
    const assertNoGroupSettings = async () => {
      // textContent also covers collapsed/hidden content, not just visible labels.
      assert(!/Group|团队|旧版|改用专家记忆/.test((await page.locator("body").textContent()) ?? ""))
      assert.equal(await page.getByLabel("已有内部 Group ID").count(), 0)
    }
    await assertNoGroupSettings()
    await page.getByText("高级设置与调试", { exact: true }).click()
    await assertNoGroupSettings()
    await page.getByText("高级设置与调试", { exact: true }).click()
    await page.getByRole("button", { name: "创建专家", exact: true }).click()
    await page.getByText("长期记忆", { exact: true }).waitFor()
    assert.equal(status.workspacePath, "/private/experts/stable-id/runtime")
    assert.equal(enables, 0)
    assert.equal(analyses, 0)
    await page.getByText("高级设置与调试", { exact: true }).click()
    await assertNoGroupSettings()
    await page.getByText("高级设置与调试", { exact: true }).click()
    await page.getByText("长期记忆", { exact: true }).click()
    await page.getByLabel("专家记忆正文").fill("业务日按交易日历计算")
    await page.getByRole("button", { name: "保存到专家记忆", exact: true }).click()
    await page.getByTestId("expert-memory-entry").waitFor()
    await page.getByLabel("检索专家记忆").fill("无匹配")
    assert.equal(await page.getByTestId("expert-memory-entry").count(), 0)
    await page.getByLabel("检索专家记忆").fill("交易日历")
    await page.getByTestId("expert-memory-entry").waitFor()
    page.once("dialog", async (dialog) => {
      prompts++
      await dialog.dismiss()
    })
    await page.getByRole("button", { name: "启用本机", exact: true }).click()
    assert.equal(enables, 0)
    page.once("dialog", async (dialog) => {
      prompts++
      assert(dialog.message().includes("不读取代码"))
      await dialog.accept()
    })
    await page.getByRole("button", { name: "启用本机", exact: true }).click()
    await page.getByRole("button", { name: "停止本机", exact: true }).waitFor()
    assert.equal(enables, 1)
    assert.equal(prompts, 2)
    await page.getByRole("button", { name: "发送给专家", exact: true }).click()
    await page.getByText("任务已保存", { exact: true }).waitFor()
    assert.equal(analyses, 0)
    await page.getByRole("button", { name: "分析需求", exact: true }).click()
    result = {
      runId: "run-ui",
      status: "succeeded",
      version: 4,
      result: { outcome: "succeeded", text: "模拟需求说明书", settledAt: "2026-10-15T02:00:00Z" },
      memorySnapshot: {
        scope: "bot",
        botId: "expert-ui",
        revision: 1,
        memories: structuredClone(memories.memories)
      }
    }
    await page.getByTestId("partner-result").waitFor()
    assert.equal(analyses, 1)
    await page.getByText("高级设置与调试", { exact: true }).click()
    await assertNoGroupSettings()
    await page.getByRole("button", { name: "编辑", exact: true }).click()
    await page.getByLabel("专家记忆正文").fill("业务日使用产品交易日历")
    await page.getByRole("button", { name: "保存修改", exact: true }).click()
    await page.getByText("业务日使用产品交易日历", { exact: true }).waitFor()
    await page.getByRole("button", { name: "停用", exact: true }).click()
    await page.getByRole("button", { name: "重新启用", exact: true }).waitFor()
    await page.getByRole("button", { name: "停止本机", exact: true }).click()
    await page.getByRole("button", { name: "启用本机", exact: true }).waitFor()
    status.connected = false
    await page
      .getByText("连接恢复前无法核对权限，暂不展示本地缓存正文。", { exact: true })
      .waitFor()
    assert.equal(await page.getByTestId("expert-memory-entry").count(), 0)
    status.connected = true
    await page.getByTestId("expert-memory-entry").waitFor()
    denyMemory = true
    result.result!.text = "无记忆维护权，仍可查看获授权的任务结果"
    await page.getByText("无记忆维护权，仍可查看获授权的任务结果", { exact: true }).waitFor()
    assert.equal(await page.getByTestId("expert-memory-entry").count(), 0)
    assert.equal(enables, 1)
    assert.equal(analyses, 1)
    await page.getByRole("button", { name: "撤销本机授权", exact: true }).click()
    assert.equal(revocations, 1)
    await assertNoGroupSettings()
    assert.deepEqual(errors, [])
    console.log(
      JSON.stringify({
        stage: "partner-panel-browser",
        actualReactComponent: true,
        actualChromium: true,
        fakeIPC: true,
        simpleExpertTaskLocalFlow: true,
        noGroupOrLegacySettingsEvenExpanded: true,
        localAuthorizationRevocation: true,
        noWorkspaceSelection: true,
        explicitEnableConfirmation: true,
        expertMemorySearchEditDisable: true,
        offlineCacheHidden: true,
        autoModelCalls: 0,
        errors: 0
      })
    )
  } finally {
    await electron?.close()
    await rm(dir, { recursive: true, force: true })
  }
}
main().catch((error) => {
  console.error(String(error))
  process.exitCode = 1
})
